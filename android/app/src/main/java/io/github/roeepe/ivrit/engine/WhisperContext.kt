package io.github.roeepe.ivrit.engine

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * A loaded model, pinned to a single thread.
 *
 * whisper.cpp state is not safe to touch from more than one thread, and the JNI
 * callbacks run on whichever thread called in — so every call is funnelled
 * through one executor rather than trusting callers to be careful.
 */
class WhisperContext private constructor(
    private var handle: Long,
    val modelPath: String,
    val usingGpu: Boolean,
) : Closeable {

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "whisper").apply { priority = Thread.MAX_PRIORITY }
    }
    private val worker: CoroutineDispatcher = executor.asCoroutineDispatcher()

    @Volatile private var closed = false

    companion object {
        /** Threads to hand whisper: leave one core for the UI, and more than 8 stops helping. */
        fun defaultThreads(): Int = min(8, max(2, Runtime.getRuntime().availableProcessors() - 1))

        suspend fun load(modelPath: String, useGpu: Boolean = false): Result<WhisperContext> {
            WhisperNative.ensureLoaded().onFailure { return Result.failure(it) }
            return withContext(Dispatchers.Default) {
                val h = runCatching { WhisperNative.initContext(modelPath, useGpu) }
                    .getOrElse { return@withContext Result.failure(it) }
                if (h == 0L) Result.failure(IllegalStateException("לא הצלחתי לטעון את המודל מ-$modelPath"))
                else Result.success(WhisperContext(h, modelPath, useGpu))
            }
        }

        suspend fun systemInfo(): String = runCatching {
            WhisperNative.ensureLoaded().getOrThrow()
            WhisperNative.systemInfo()
        }.getOrElse { "לא זמין: ${it.message}" }
    }

    /**
     * Transcribes one chunk. [offsetSec] is added to every timestamp so segments
     * from different chunks land on one timeline.
     */
    suspend fun transcribe(
        pcm: FloatArray,
        language: String = "he",
        beamSize: Int = 5,
        offsetSec: Double = 0.0,
        threads: Int = defaultThreads(),
        initialPrompt: String = "",
        segmentSink: (WhisperSegment) -> Unit = {},
        progressSink: (Int) -> Unit = {},
        cancelled: () -> Boolean = { false },
    ): Result<Unit> = withContext(worker) {
        if (closed) return@withContext Result.failure(IllegalStateException("המודל כבר שוחרר"))
        // The overrides and the lambdas must not share names, or the overrides
        // would recurse into themselves instead of calling out.
        val listener = object : WhisperCallback {
            override fun onSegment(startSec: Double, endSec: Double, text: String) {
                val trimmed = text.trim()
                if (trimmed.isNotEmpty()) segmentSink(WhisperSegment(startSec, endSec, trimmed))
            }
            override fun onProgress(percent: Int) = progressSink(percent)
            override fun isCancelled(): Boolean = cancelled()
        }
        val rc = runCatching {
            WhisperNative.transcribe(handle, pcm, language, threads, beamSize, offsetSec, false, initialPrompt, listener)
        }.getOrElse { return@withContext Result.failure(it) }

        if (rc == 0 || cancelled()) Result.success(Unit)
        else Result.failure(IllegalStateException("whisper_full נכשל עם קוד $rc"))
    }

    override fun close() {
        if (closed) return
        closed = true
        val h = handle
        handle = 0
        // Free on the same thread that used the context, then retire the thread.
        executor.execute { if (h != 0L) runCatching { WhisperNative.freeContext(h) } }
        executor.shutdown()
    }
}
