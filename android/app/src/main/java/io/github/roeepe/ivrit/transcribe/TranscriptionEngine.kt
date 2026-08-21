package io.github.roeepe.ivrit.transcribe

import android.content.Context
import android.net.Uri
import io.github.roeepe.ivrit.audio.AudioDecoder
import io.github.roeepe.ivrit.engine.WhisperContext
import io.github.roeepe.ivrit.engine.WhisperSegment
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File

/**
 * Runs a whole recording through the model, in two passes.
 *
 * Pass one decodes to a scratch file of 16 kHz mono 16-bit PCM — 115 MB for a
 * two-hour recording, versus the gigabytes the same audio would occupy as
 * in-memory float. Pass two walks that file in windows and hands each to
 * whisper. Memory stays flat whatever the recording's length, which is the
 * failure mode the browser version could only warn about.
 */
class TranscriptionEngine(private val context: Context) {

    data class Progress(
        val stage: String,
        val audioDoneSec: Double,
        val audioTotalSec: Double,
        val observedRealtimeFactor: Double,
        val etaSec: Double,
        val segments: List<WhisperSegment>,
    ) {
        val ratio: Double get() = if (audioTotalSec > 0) (audioDoneSec / audioTotalSec).coerceIn(0.0, 1.0) else 0.0
    }

    data class Outcome(
        val ok: Boolean,
        val segments: List<WhisperSegment>,
        val text: String,
        val audioSec: Double,
        val decodeSec: Double,
        val loadSec: Double,
        val inferSec: Double,
        val totalSec: Double,
        val error: String? = null,
    )

    private val _progress = MutableStateFlow<Progress?>(null)
    val progress: StateFlow<Progress?> = _progress

    @Volatile private var cancelled = false
    fun cancel() { cancelled = true }

    suspend fun run(
        audioUri: Uri,
        modelFile: File,
        language: String = "he",
        beamSize: Int = 5,
        windowSec: Double = 120.0,
    ): Outcome {
        cancelled = false
        val startedAt = System.nanoTime()
        val segments = mutableListOf<WhisperSegment>()
        val scratch = File(context.cacheDir, "decoded-16k.pcm")

        try {
            val info = AudioDecoder.probe(context, audioUri)

            // ── pass one: decode to disk ──────────────────────────────────
            _progress.value = Progress("מפענח את האודיו", 0.0, info.durationSec, 0.0, Double.NaN, emptyList())
            val decodeStart = System.nanoTime()
            var samplesWritten = 0L
            DataOutputStream(BufferedOutputStream(scratch.outputStream(), 1 shl 16)).use { out ->
                AudioDecoder.decode(
                    context = context,
                    uri = audioUri,
                    onAudio = { block, _ ->
                        for (s in block) {
                            val v = (s * 32767f).coerceIn(-32768f, 32767f).toInt()
                            // Little-endian, matching the read side below.
                            out.write(v and 0xFF)
                            out.write((v shr 8) and 0xFF)
                        }
                        samplesWritten += block.size
                    },
                    onProgress = { r ->
                        _progress.value = Progress("מפענח את האודיו", r * info.durationSec, info.durationSec, 0.0, Double.NaN, emptyList())
                    },
                    cancelled = { cancelled },
                )
            }
            val decodeSec = (System.nanoTime() - decodeStart) / 1e9
            val audioSec = samplesWritten / 16000.0
            if (cancelled) return cancelledOutcome(segments, audioSec, decodeSec, startedAt)
            if (samplesWritten == 0L) return failure("לא הופקו דגימות מהקובץ", segments, startedAt)

            // ── pass two: transcribe window by window ─────────────────────
            _progress.value = Progress("טוען את המודל", 0.0, audioSec, 0.0, Double.NaN, emptyList())
            val loadStart = System.nanoTime()
            val ctx = WhisperContext.load(modelFile.absolutePath, useGpu = false).getOrThrow()
            val loadSec = (System.nanoTime() - loadStart) / 1e9

            var inferNanos = 0L
            try {
                val windowSamples = (windowSec * 16000).toInt()
                val buffer = FloatArray(windowSamples)
                var offsetSec = 0.0

                DataInputStream(BufferedInputStream(scratch.inputStream(), 1 shl 16)).use { input ->
                    val raw = ByteArray(windowSamples * 2)
                    while (!cancelled) {
                        val read = input.readNBytes(raw, 0, raw.size)
                        if (read <= 0) break
                        val count = read / 2
                        for (i in 0 until count) {
                            val lo = raw[i * 2].toInt() and 0xFF
                            val hi = raw[i * 2 + 1].toInt()
                            buffer[i] = ((hi shl 8) or lo).toShort() / 32768f
                        }
                        val chunk = if (count == windowSamples) buffer else buffer.copyOf(count)

                        val t0 = System.nanoTime()
                        ctx.transcribe(
                            pcm = chunk,
                            language = language,
                            beamSize = beamSize,
                            offsetSec = offsetSec,
                            segmentSink = { seg ->
                                segments += seg
                                val elapsed = (inferNanos + System.nanoTime() - t0) / 1e9
                                val rtf = if (elapsed > 0.1) seg.endSec / elapsed else 0.0
                                _progress.value = Progress(
                                    stage = "מתמלל",
                                    audioDoneSec = seg.endSec,
                                    audioTotalSec = audioSec,
                                    observedRealtimeFactor = rtf,
                                    etaSec = if (rtf > 0.01) (audioSec - seg.endSec) / rtf else Double.NaN,
                                    segments = segments.toList(),
                                )
                            },
                            cancelled = { cancelled },
                        ).getOrThrow()
                        inferNanos += System.nanoTime() - t0
                        offsetSec += count / 16000.0
                    }
                }

                val ordered = segments.sortedBy { it.startSec }
                return Outcome(
                    ok = !cancelled,
                    segments = ordered,
                    text = ordered.joinToString(" ") { it.text }.trim(),
                    audioSec = audioSec,
                    decodeSec = decodeSec,
                    loadSec = loadSec,
                    inferSec = inferNanos / 1e9,
                    totalSec = (System.nanoTime() - startedAt) / 1e9,
                    error = if (cancelled) "בוטל" else null,
                )
            } finally {
                ctx.close()
            }
        } catch (t: Throwable) {
            return failure(t.message ?: t.toString(), segments, startedAt)
        } finally {
            scratch.delete()
        }
    }

    private fun cancelledOutcome(segments: List<WhisperSegment>, audioSec: Double, decodeSec: Double, startedAt: Long) =
        Outcome(false, segments.sortedBy { it.startSec }, "", audioSec, decodeSec, 0.0, 0.0,
            (System.nanoTime() - startedAt) / 1e9, "בוטל")

    private fun failure(message: String, segments: List<WhisperSegment>, startedAt: Long): Outcome {
        val ordered = segments.sortedBy { it.startSec }
        return Outcome(
            ok = false,
            segments = ordered,
            text = ordered.joinToString(" ") { it.text }.trim(),
            audioSec = 0.0, decodeSec = 0.0, loadSec = 0.0, inferSec = 0.0,
            totalSec = (System.nanoTime() - startedAt) / 1e9,
            error = message,
        )
    }
}
