package io.github.roeepe.ivrit.estimator

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/**
 * Turns finished runs into evidence. After the first real transcription the
 * estimate stops leaning on PRIORS for throughput and uses what this phone
 * actually did, and the uncertainty band narrows accordingly.
 */
object Calibration {

    private const val PREFS = "ivrit.calibration"
    private const val KEY = "state.v1"
    private const val MAX_HISTORY = 40
    private const val ALPHA = 0.4     // weight on the newest sample

    data class RouteStats(
        val route: String,
        val realtimeFactor: Double?,
        val runs: Int,
        val failures: Int,
        val batteryPerHour: Double?,
    )

    data class Run(
        val route: String,
        val ok: Boolean,
        val audioSec: Double,
        val inferSec: Double,
        val totalSec: Double,
        val estimatedSec: Double,
        val batteryDropPercent: Double?,
        val thermalAtEnd: Int,
        val error: String?,
        val at: Long = System.currentTimeMillis(),
    )

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun load(context: Context): JSONObject =
        runCatching { JSONObject(prefs(context).getString(KEY, "{}") ?: "{}") }.getOrElse { JSONObject() }

    private fun save(context: Context, obj: JSONObject) {
        prefs(context).edit().putString(KEY, obj.toString()).apply()
    }

    fun statsFor(context: Context, route: String): RouteStats? {
        val routes = load(context).optJSONObject("routes") ?: return null
        val r = routes.optJSONObject(route) ?: return null
        val runs = r.optInt("runs")
        if (runs == 0) return null
        return RouteStats(
            route = route,
            realtimeFactor = r.optDouble("rtf").takeIf { !it.isNaN() && it > 0 },
            runs = runs,
            failures = r.optInt("failures"),
            batteryPerHour = r.optDouble("batteryPerHour").takeIf { !it.isNaN() && it > 0 },
        )
    }

    fun record(context: Context, run: Run) {
        val root = load(context)
        val routes = root.optJSONObject("routes") ?: JSONObject().also { root.put("routes", it) }
        val r = routes.optJSONObject(run.route) ?: JSONObject().also { routes.put(run.route, it) }

        r.put("runs", r.optInt("runs") + 1)
        if (!run.ok) r.put("failures", r.optInt("failures") + 1)

        // Only a run long enough to be dominated by steady-state decoding tells
        // you anything about throughput.
        if (run.ok && run.audioSec > 10 && run.inferSec > 2) {
            val sample = run.audioSec / run.inferSec
            val prev = r.optDouble("rtf").takeIf { !it.isNaN() && it > 0 }
            r.put("rtf", if (prev == null) sample else prev * (1 - ALPHA) + sample * ALPHA)
        }
        if (run.batteryDropPercent != null && run.totalSec > 120) {
            val perHour = run.batteryDropPercent / (run.totalSec / 3600)
            if (perHour > 0) {
                val prev = r.optDouble("batteryPerHour").takeIf { !it.isNaN() && it > 0 }
                r.put("batteryPerHour", if (prev == null) perHour else prev * (1 - ALPHA) + perHour * ALPHA)
            }
        }

        val history = root.optJSONArray("history") ?: JSONArray().also { root.put("history", it) }
        val entry = JSONObject()
            .put("at", run.at).put("route", run.route).put("ok", run.ok)
            .put("audioSec", run.audioSec).put("totalSec", run.totalSec)
            .put("inferSec", run.inferSec).put("estimatedSec", run.estimatedSec)
            .put("thermal", run.thermalAtEnd)
            .put("error", run.error ?: JSONObject.NULL)
        val trimmed = JSONArray().put(entry)
        for (i in 0 until minOf(history.length(), MAX_HISTORY - 1)) trimmed.put(history.get(i))
        root.put("history", trimmed)

        save(context, root)
    }

    /** How close past predictions came — shown in the UI so the numbers stay accountable. */
    data class Accuracy(val samples: Int, val medianRatio: Double, val withinBand: Double)

    fun accuracy(context: Context): Accuracy? {
        val history = load(context).optJSONArray("history") ?: return null
        val ratios = mutableListOf<Double>()
        for (i in 0 until history.length()) {
            val o = history.optJSONObject(i) ?: continue
            if (!o.optBoolean("ok")) continue
            val est = o.optDouble("estimatedSec")
            val actual = o.optDouble("totalSec")
            if (est > 1 && actual > 1) ratios += actual / est
        }
        if (ratios.isEmpty()) return null
        ratios.sort()
        return Accuracy(
            samples = ratios.size,
            medianRatio = ratios[ratios.size / 2],
            withinBand = ratios.count { abs(it - 1.0) < 0.6 }.toDouble() / ratios.size,
        )
    }

    fun reset(context: Context) = prefs(context).edit().clear().apply()
}
