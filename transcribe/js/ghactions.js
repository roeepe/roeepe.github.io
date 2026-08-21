// The "transcribe on a git server" route: dispatch the repo's transcribe
// workflow, then watch the run. The audio itself never enters git — it goes to
// Drive, and the runner pulls it from there with a service account.

import { store, sleep } from "./util.js";

const GH = "https://api.github.com";
const WORKFLOW = "transcribe.yml";

export const config = {
  get repo() { return store.get("gh.repo", "roeepe/roeepe.github.io"); },
  set repo(v) { store.set("gh.repo", (v || "").trim()); },
  get ref() { return store.get("gh.ref", "main"); },
  set ref(v) { store.set("gh.ref", (v || "main").trim()); },
  get token() { return store.get("gh.token", ""); },
  set token(v) { store.set("gh.token", (v || "").trim()); },
  get serviceAccount() { return store.get("gh.serviceAccount", ""); },
  set serviceAccount(v) { store.set("gh.serviceAccount", (v || "").trim()); },
  get configured() { return !!(this.repo && this.token); },
};

async function api(path, init = {}) {
  const r = await fetch(GH + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${config.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (r.status === 204) return null;
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const hint = r.status === 401 ? " — הטוקן לא תקף או פג" :
                 r.status === 403 ? " — לטוקן אין הרשאת Actions על המאגר" :
                 r.status === 404 ? " — המאגר או ה-workflow לא נמצאו (יש להריץ את הענף שמכיל את transcribe.yml)" : "";
    throw new Error(`GitHub ${r.status}${hint}: ${body?.message || text.slice(0, 200)}`);
  }
  return body;
}

export async function checkAccess() {
  const repo = await api(`/repos/${config.repo}`);
  const wf = await api(`/repos/${config.repo}/actions/workflows/${WORKFLOW}`).catch(() => null);
  return { repo: repo.full_name, private: repo.private, workflowFound: !!wf, workflowState: wf?.state || null };
}

/**
 * Fires the workflow and finds the run it created. GitHub's dispatch endpoint
 * returns 204 with no run id, so the run is matched by start time.
 */
export async function dispatch({ audioFileId, resultFileId, model, language = "he", beamSize = 5 }) {
  const since = new Date(Date.now() - 60_000).toISOString();
  await api(`/repos/${config.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      ref: config.ref,
      inputs: {
        audio_file_id: audioFileId,
        result_file_id: resultFileId,
        model: model || "ivrit-ai/whisper-large-v3-turbo-ct2",
        language,
        beam_size: String(beamSize),
      },
    }),
  });

  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    const runs = await api(`/repos/${config.repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&created=>${since}&per_page=5`);
    const run = runs?.workflow_runs?.[0];
    if (run) {
      const record = { id: run.id, url: run.html_url, status: run.status, createdAt: Date.now(), audioFileId, resultFileId };
      store.set("gh.jobs", [record, ...store.get("gh.jobs", [])].slice(0, 20));
      return record;
    }
  }
  // The job is running even if the run could not be matched; Drive polling still works.
  return { id: null, url: `https://github.com/${config.repo}/actions/workflows/${WORKFLOW}`, status: "unknown", audioFileId, resultFileId };
}

export async function runStatus(runId) {
  if (!runId) return null;
  const r = await api(`/repos/${config.repo}/actions/runs/${runId}`);
  return { status: r.status, conclusion: r.conclusion, url: r.html_url, startedAt: r.run_started_at, updatedAt: r.updated_at };
}

export async function cancelRun(runId) {
  if (!runId) return;
  await api(`/repos/${config.repo}/actions/runs/${runId}/cancel`, { method: "POST" });
}

export const recentRuns = () => store.get("gh.jobs", []);
