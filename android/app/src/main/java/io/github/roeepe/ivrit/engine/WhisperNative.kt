package io.github.roeepe.ivrit.engine

/**
 * Direct binding to whisper_jni.cpp. Declared as an `object` so every entry
 * point is an instance method, which is what the JNI signatures in the native
 * layer expect.
 *
 * Nothing here is thread-safe: a [WhisperContext] handle belongs to one worker.
 */
object WhisperNative {
    @Volatile private var loaded = false

    /** Loading is deferred so a failure surfaces as a message rather than a crash at class-init. */
    fun ensureLoaded(): Result<Unit> = synchronized(this) {
        if (loaded) return Result.success(Unit)
        return runCatching {
            System.loadLibrary("ivritwhisper")
            loaded = true
        }
    }

    external fun systemInfo(): String

    /** whisper.cpp's own ggml matmul benchmark — the honest measure of this phone's throughput. */
    external fun benchMatmul(threads: Int): String

    /** @return an opaque whisper_context pointer, or 0 if the model could not be loaded. */
    external fun initContext(modelPath: String, useGpu: Boolean): Long

    external fun freeContext(handle: Long)

    /** @return 0 on success, whisper_full()'s error code otherwise. */
    external fun transcribe(
        handle: Long,
        pcm: FloatArray,
        language: String,
        threads: Int,
        beamSize: Int,
        offsetSec: Double,
        translate: Boolean,
        initialPrompt: String,
        listener: WhisperCallback,
    ): Int
}

/** Called from the native decode loop. Keep the implementations cheap. */
interface WhisperCallback {
    fun onSegment(startSec: Double, endSec: Double, text: String)
    fun onProgress(percent: Int)
    fun isCancelled(): Boolean
}

data class WhisperSegment(val startSec: Double, val endSec: Double, val text: String)
