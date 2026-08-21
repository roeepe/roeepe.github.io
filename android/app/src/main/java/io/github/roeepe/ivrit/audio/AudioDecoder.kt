package io.github.roeepe.ivrit.audio

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes any container Android can open — m4a, mp3, opus, webm, wav, or the
 * audio track of an mp4 — into 16 kHz mono float, streaming.
 *
 * Streaming is the whole point: a two-hour recording decoded in one piece is
 * hundreds of megabytes of float, which is exactly the out-of-memory failure
 * the web version has to warn about. Here the peak is one codec buffer.
 */
object AudioDecoder {

    data class Info(
        val durationSec: Double,
        val sampleRate: Int,
        val channels: Int,
        val mime: String,
        val sizeBytes: Long,
    )

    class UnsupportedAudio(message: String) : Exception(message)

    private fun openExtractor(context: Context, uri: Uri): Pair<MediaExtractor, Int> {
        val extractor = MediaExtractor()
        extractor.setDataSource(context, uri, null)
        for (i in 0 until extractor.trackCount) {
            val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) return extractor to i
        }
        extractor.release()
        throw UnsupportedAudio("לא נמצא ערוץ אודיו בקובץ")
    }

    suspend fun probe(context: Context, uri: Uri): Info = withContext(Dispatchers.IO) {
        val (extractor, track) = openExtractor(context, uri)
        try {
            val f = extractor.getTrackFormat(track)
            val size = runCatching {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
            }.getOrNull() ?: -1L
            Info(
                durationSec = if (f.containsKey(MediaFormat.KEY_DURATION)) f.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0 else 0.0,
                sampleRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE),
                channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT),
                mime = f.getString(MediaFormat.KEY_MIME) ?: "audio/unknown",
                sizeBytes = size,
            )
        } finally {
            extractor.release()
        }
    }

    /**
     * Decodes the whole track, handing 16 kHz mono blocks to [onAudio] as they
     * become available.
     *
     * @param onAudio receives (samples, startSecOfBlock)
     * @param onProgress fraction of the recording decoded so far
     */
    suspend fun decode(
        context: Context,
        uri: Uri,
        onAudio: (FloatArray, Double) -> Unit,
        onProgress: (Double) -> Unit = {},
        cancelled: () -> Boolean = { false },
    ): Int = withContext(Dispatchers.IO) {
        val (extractor, track) = openExtractor(context, uri)
        extractor.selectTrack(track)
        val format = extractor.getTrackFormat(track)
        val mime = format.getString(MediaFormat.KEY_MIME)!!
        val inRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val inChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L

        val codec = MediaCodec.createDecoderByType(mime)
        val resampler = Resampler(inRate)
        var emitted = 0
        var outPos = 0.0     // seconds of 16 kHz audio handed over so far

        try {
            codec.configure(format, null, null, 0)
            codec.start()

            val bufferInfo = MediaCodec.BufferInfo()
            var sawInputEos = false
            var sawOutputEos = false

            while (!sawOutputEos) {
                if (cancelled()) break

                if (!sawInputEos) {
                    val inIndex = codec.dequeueInputBuffer(10_000)
                    if (inIndex >= 0) {
                        val inBuf = codec.getInputBuffer(inIndex)!!
                        val sampleSize = extractor.readSampleData(inBuf, 0)
                        if (sampleSize < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEos = true
                        } else {
                            codec.queueInputBuffer(inIndex, 0, sampleSize, extractor.sampleTime, 0)
                            if (durationUs > 0) onProgress((extractor.sampleTime.toDouble() / durationUs).coerceIn(0.0, 1.0))
                            extractor.advance()
                        }
                    }
                }

                when (val outIndex = codec.dequeueOutputBuffer(bufferInfo, 10_000)) {
                    MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                    MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> Unit
                    else -> if (outIndex >= 0) {
                        if (bufferInfo.size > 0) {
                            val outBuf = codec.getOutputBuffer(outIndex)!!
                            val mono = toMonoFloat(outBuf, bufferInfo, codec.outputFormat, inChannels)
                            val resampled = resampler.process(mono)
                            if (resampled.isNotEmpty()) {
                                onAudio(resampled, outPos)
                                outPos += resampled.size / 16000.0
                                emitted += resampled.size
                            }
                        }
                        codec.releaseOutputBuffer(outIndex, false)
                        if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEos = true
                    }
                }
            }

            val tail = resampler.flush()
            if (tail.isNotEmpty() && !cancelled()) {
                onAudio(tail, outPos)
                emitted += tail.size
            }
            onProgress(1.0)
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            extractor.release()
        }
        emitted
    }

    /**
     * Codecs hand back either 16-bit or float PCM depending on the device, and
     * either has to end up as mono float in [-1, 1].
     */
    private fun toMonoFloat(
        buffer: ByteBuffer,
        info: MediaCodec.BufferInfo,
        outputFormat: MediaFormat,
        fallbackChannels: Int,
    ): FloatArray {
        val channels = if (outputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT))
            outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else fallbackChannels
        val isFloat = outputFormat.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
            outputFormat.getInteger(MediaFormat.KEY_PCM_ENCODING) == 4  // AudioFormat.ENCODING_PCM_FLOAT

        buffer.position(info.offset)
        buffer.limit(info.offset + info.size)
        val slice = buffer.slice().order(ByteOrder.nativeOrder())

        return if (isFloat) {
            val fb = slice.asFloatBuffer()
            val frames = fb.remaining() / channels
            FloatArray(frames) { i ->
                var acc = 0f
                for (c in 0 until channels) acc += fb.get(i * channels + c)
                acc / channels
            }
        } else {
            val sb = slice.asShortBuffer()
            val frames = sb.remaining() / channels
            FloatArray(frames) { i ->
                var acc = 0f
                for (c in 0 until channels) acc += sb.get(i * channels + c) / 32768f
                acc / channels
            }
        }
    }
}
