package io.github.roeepe.ivrit.model

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Finds, downloads and keeps track of the ggml weights.
 *
 * Sizes come from the Hugging Face API rather than a hardcoded table, so the
 * estimator works with the real byte count of whatever variant is chosen, and
 * downloads resume with a Range request instead of restarting a gigabyte.
 */
object ModelStore {

    private const val HF = "https://huggingface.co"

    data class Repo(val id: String, val title: String, val note: String, val hebrew: Boolean)

    data class Variant(
        val repoId: String,
        val fileName: String,
        val sizeBytes: Long,
        /** Rough quality ordering, used only to break ties when several fit. */
        val quality: Int,
    ) {
        val url: String get() = "$HF/$repoId/resolve/main/$fileName?download=true"
        val label: String get() = fileName.removePrefix("ggml-").removeSuffix(".bin")
    }

    val CATALOG = listOf(
        Repo(
            "ivrit-ai/whisper-large-v3-turbo-ggml",
            "ivrit-ai large-v3-turbo",
            "הפיינטיון העברי, בפורמט ggml. ברירת המחדל.",
            hebrew = true,
        ),
        Repo(
            "ivrit-ai/whisper-large-v3-ggml",
            "ivrit-ai large-v3",
            "איטי יותר מ-turbo, לפעמים מדויק יותר.",
            hebrew = true,
        ),
        Repo(
            "ggml-org/whisper.cpp",
            "whisper.cpp הרשמי (רב-לשוני)",
            "כולל דגמים זעירים כמו base ו-small — שימושי לבדוק שהצינור עובד.",
            hebrew = false,
        ),
    )

    fun modelsDir(context: Context): File =
        File(context.filesDir, "models").apply { mkdirs() }

    fun localFile(context: Context, variant: Variant): File =
        File(modelsDir(context), "${variant.repoId.replace('/', '_')}__${variant.fileName}")

    fun isDownloaded(context: Context, variant: Variant): Boolean {
        val f = localFile(context, variant)
        return f.exists() && f.length() == variant.sizeBytes
    }

    fun downloadedBytes(context: Context, variant: Variant): Long =
        localFile(context, variant).let { if (it.exists()) it.length() else 0L }

    /** Lists the .bin weights in a repo, newest-style quantisations first. */
    suspend fun listVariants(repoId: String): Result<List<Variant>> = withContext(Dispatchers.IO) {
        runCatching {
            val json = httpGetText("$HF/api/models/$repoId/tree/main")
            val arr = JSONArray(json)
            val out = mutableListOf<Variant>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (o.optString("type") != "file") continue
                val path = o.optString("path")
                if (!path.endsWith(".bin") || !path.contains("ggml")) continue
                if (path.contains("test") || path.contains("tdrz")) continue
                val size = o.optJSONObject("lfs")?.optLong("size") ?: o.optLong("size")
                if (size <= 0) continue
                out += Variant(repoId, path, size, qualityOf(path))
            }
            out.sortedWith(compareByDescending<Variant> { it.quality }.thenBy { it.sizeBytes })
        }
    }

    /** Quantisation ranking: heavier formats keep more of the model's accuracy. */
    private fun qualityOf(name: String): Int = when {
        name.contains("f32") -> 100
        name.contains("f16") -> 95
        name.contains("q8") -> 90
        name.contains("q6") -> 85
        name.contains("q5_1") -> 82
        name.contains("q5_0") || name.contains("q5") -> 80
        name.contains("q4_1") -> 72
        name.contains("q4") -> 70
        else -> 88   // an unsuffixed ggml-*.bin is usually f16
    }

    /**
     * Picks the best variant that comfortably fits: the model is memory-mapped,
     * but the phone still has to hold it, and a variant that forces constant
     * paging is slower than a smaller one that fits.
     */
    fun pick(variants: List<Variant>, budgetBytes: Long): Variant? {
        val fitting = variants.filter { it.sizeBytes * 11 / 10 < budgetBytes }
        return fitting.maxByOrNull { it.quality } ?: variants.minByOrNull { it.sizeBytes }
    }

    data class Progress(val downloadedBytes: Long, val totalBytes: Long, val bytesPerSec: Double) {
        val ratio: Double get() = if (totalBytes > 0) downloadedBytes.toDouble() / totalBytes else 0.0
        val etaSec: Double get() = if (bytesPerSec > 1) (totalBytes - downloadedBytes) / bytesPerSec else Double.NaN
    }

    /**
     * Downloads a variant, resuming a partial file rather than starting over —
     * the difference between a dropped connection costing seconds and costing
     * the whole gigabyte.
     */
    suspend fun download(
        context: Context,
        variant: Variant,
        onProgress: (Progress) -> Unit = {},
        cancelled: () -> Boolean = { false },
    ): Result<File> = withContext(Dispatchers.IO) {
        val target = localFile(context, variant)
        if (isDownloaded(context, variant)) return@withContext Result.success(target)

        runCatching {
            var existing = if (target.exists()) target.length() else 0L
            if (existing > variant.sizeBytes) { target.delete(); existing = 0L }

            val conn = (URL(variant.url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 30_000
                readTimeout = 60_000
                instanceFollowRedirects = true
                if (existing > 0) setRequestProperty("Range", "bytes=$existing-")
            }
            conn.connect()
            val code = conn.responseCode
            if (code == 416) { // the server says we already have all of it
                conn.disconnect()
                return@runCatching target
            }
            if (code !in 200..299) throw IOException("HTTP $code בהורדת ${variant.fileName}")
            val resuming = code == 206
            if (!resuming) existing = 0L

            val started = System.nanoTime()
            var written = existing
            conn.inputStream.use { input ->
                java.io.FileOutputStream(target, resuming).use { output ->
                    val buf = ByteArray(1 shl 16)
                    var lastReport = 0L
                    while (true) {
                        if (cancelled()) throw IOException("ההורדה בוטלה")
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        written += n
                        val now = System.nanoTime()
                        if (now - lastReport > 250_000_000L) {
                            lastReport = now
                            val elapsed = (now - started) / 1e9
                            val rate = if (elapsed > 0.2) (written - existing) / elapsed else 0.0
                            onProgress(Progress(written, variant.sizeBytes, rate))
                        }
                    }
                }
            }
            conn.disconnect()
            onProgress(Progress(written, variant.sizeBytes, 0.0))

            if (written != variant.sizeBytes) {
                throw IOException("הקובץ שהתקבל חלקי: $written מתוך ${variant.sizeBytes}")
            }
            target
        }
    }

    fun delete(context: Context, variant: Variant): Boolean = localFile(context, variant).delete()

    fun installed(context: Context): List<File> =
        modelsDir(context).listFiles()?.toList().orEmpty()

    private fun httpGetText(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (conn.responseCode !in 200..299) throw IOException("HTTP ${conn.responseCode} עבור $url")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}
