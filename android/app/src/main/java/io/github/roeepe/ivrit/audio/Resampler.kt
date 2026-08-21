package io.github.roeepe.ivrit.audio

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Streaming windowed-sinc resampler to Whisper's 16 kHz.
 *
 * Linear interpolation would be cheaper, but going from 44.1/48 kHz down to
 * 16 kHz folds everything above 8 kHz back into the speech band, and that lands
 * as noise in the transcript. The sinc kernel low-passes and resamples in one
 * pass; next to the model itself the cost is not measurable.
 */
class Resampler(private val inRate: Int, private val outRate: Int = 16000) {

    private val ratio = inRate.toDouble() / outRate
    // Anti-aliasing: when downsampling, the cutoff follows the output rate.
    private val cutoff = min(1.0, outRate.toDouble() / inRate) * 0.94
    private val halfTaps = 24

    /** Input samples kept around because the next output window reaches back into them. */
    private var history = FloatArray(0)
    /** Position of the next output sample, in input-sample units, relative to `history[0]`. */
    private var pos = 0.0

    val passthrough: Boolean get() = inRate == outRate

    private fun kernel(x: Double): Double {
        if (abs(x) < 1e-9) return cutoff
        if (abs(x) > halfTaps) return 0.0
        val sinc = sin(PI * cutoff * x) / (PI * x)
        // Blackman window over the kernel support.
        val w = 0.42 + 0.5 * cos(PI * x / halfTaps) + 0.08 * cos(2 * PI * x / halfTaps)
        return sinc * w
    }

    /**
     * Feeds one block of input and returns whatever output samples are now
     * complete. Call [flush] once at the end for the tail.
     */
    fun process(input: FloatArray): FloatArray {
        if (passthrough) return input
        val buf = if (history.isEmpty()) input else history + input
        // The last `halfTaps` samples cannot be resolved until more input arrives.
        val usableEnd = buf.size - halfTaps
        if (usableEnd <= 0) { history = buf; return FloatArray(0) }

        val outCount = ceil((usableEnd - pos) / ratio).toInt().coerceAtLeast(0)
        val out = FloatArray(outCount)
        var produced = 0
        var p = pos
        while (produced < outCount) {
            val center = p.toInt()
            var acc = 0.0
            var norm = 0.0
            var k = center - halfTaps + 1
            val last = center + halfTaps
            while (k <= last) {
                if (k in buf.indices) {
                    val w = kernel(p - k)
                    acc += buf[k] * w
                    norm += w
                }
                k++
            }
            out[produced++] = if (norm > 1e-9) (acc / norm).toFloat() else 0f
            p += ratio
        }

        // Keep only what the next window still needs, and rebase the position.
        val consumed = p.toInt() - halfTaps + 1
        val keepFrom = consumed.coerceIn(0, buf.size)
        history = buf.copyOfRange(keepFrom, buf.size)
        pos = p - keepFrom
        return out
    }

    /** Drains the tail by padding with silence so the final samples are emitted. */
    fun flush(): FloatArray {
        if (passthrough) return FloatArray(0)
        val out = process(FloatArray(halfTaps * 2))
        history = FloatArray(0)
        pos = 0.0
        return out
    }
}
