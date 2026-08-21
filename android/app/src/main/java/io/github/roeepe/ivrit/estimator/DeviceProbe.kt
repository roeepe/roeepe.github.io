package io.github.roeepe.ivrit.estimator

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import io.github.roeepe.ivrit.engine.WhisperNative
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * What this phone can actually offer — read from Android, not guessed.
 *
 * Native code sees things a browser never does: the real total and available
 * RAM including the low-memory threshold the system kills processes at, the
 * thermal state the SoC is currently in, battery temperature and charge
 * current, and both directions of the network's estimated bandwidth. Those are
 * exactly the inputs the estimate was weakest on in the web version.
 */
data class DeviceFacts(
    val cores: Int,
    val totalMemBytes: Long,
    val availMemBytes: Long,
    val lowMemThresholdBytes: Long,
    val isLowMemory: Boolean,
    val freeStorageBytes: Long,
    val batteryPercent: Int?,
    val isCharging: Boolean,
    val batteryTempC: Double?,
    val thermalStatus: Int,
    val thermalLabel: String,
    val network: NetworkFacts,
    val soc: String,
    val androidRelease: String,
) {
    /**
     * How much the app can hold before Android starts killing it. The
     * low-memory threshold is the system's own answer, so it beats any
     * fraction-of-RAM rule of thumb.
     */
    val memoryBudgetBytes: Long
        get() = (availMemBytes - lowMemThresholdBytes).coerceAtLeast(64L * 1024 * 1024)
}

data class NetworkFacts(
    val connected: Boolean,
    val wifi: Boolean,
    val cellular: Boolean,
    val metered: Boolean,
    val downKbps: Int,
    val upKbps: Int,
) {
    val downBytesPerSec: Double get() = downKbps * 1000.0 / 8
    val upBytesPerSec: Double get() = upKbps * 1000.0 / 8
    val label: String get() = when {
        !connected -> "אין חיבור"
        wifi -> "Wi-Fi"
        cellular -> if (metered) "סלולרי (בתשלום לפי נפח)" else "סלולרי"
        else -> "מחובר"
    }
}

object DeviceProbe {

    fun read(context: Context): DeviceFacts {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }

        val stat = StatFs(context.filesDir.absolutePath)
        val freeStorage = stat.availableBlocksLong * stat.blockSizeLong

        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
        val sticky: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val tempC = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            ?.takeIf { it != Int.MIN_VALUE }?.let { it / 10.0 }

        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val thermal = pm.currentThermalStatus

        return DeviceFacts(
            cores = Runtime.getRuntime().availableProcessors(),
            totalMemBytes = mem.totalMem,
            availMemBytes = mem.availMem,
            lowMemThresholdBytes = mem.threshold,
            isLowMemory = mem.lowMemory,
            freeStorageBytes = freeStorage,
            batteryPercent = level,
            isCharging = charging,
            batteryTempC = tempC,
            thermalStatus = thermal,
            thermalLabel = thermalLabel(thermal),
            network = readNetwork(context),
            soc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}".trim() else Build.HARDWARE,
            androidRelease = Build.VERSION.RELEASE,
        )
    }

    /** Live thermal state — the signal the browser has no access to at all. */
    fun thermalLabel(status: Int): String = when (status) {
        PowerManager.THERMAL_STATUS_NONE -> "קריר"
        PowerManager.THERMAL_STATUS_LIGHT -> "מתחמם קלות"
        PowerManager.THERMAL_STATUS_MODERATE -> "חם — הביצועים כבר מוגבלים"
        PowerManager.THERMAL_STATUS_SEVERE -> "חם מאוד — ויסות משמעותי"
        PowerManager.THERMAL_STATUS_CRITICAL -> "קריטי"
        PowerManager.THERMAL_STATUS_EMERGENCY, PowerManager.THERMAL_STATUS_SHUTDOWN -> "חירום תרמי"
        else -> "לא ידוע"
    }

    /** Multiplier the SoC is already imposing before the job even starts. */
    fun thermalDerate(status: Int): Double = when (status) {
        PowerManager.THERMAL_STATUS_NONE -> 1.0
        PowerManager.THERMAL_STATUS_LIGHT -> 0.92
        PowerManager.THERMAL_STATUS_MODERATE -> 0.75
        PowerManager.THERMAL_STATUS_SEVERE -> 0.5
        else -> 0.35
    }

    private fun readNetwork(context: Context): NetworkFacts {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return NetworkFacts(false, false, false, false, 0, 0)
        val caps = cm.getNetworkCapabilities(net) ?: return NetworkFacts(false, false, false, false, 0, 0)
        return NetworkFacts(
            connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            cellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
            metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            downKbps = caps.linkDownstreamBandwidthKbps,
            upKbps = caps.linkUpstreamBandwidthKbps,
        )
    }

    /**
     * Runs whisper.cpp's own ggml matmul benchmark and pulls the peak GFLOPS out
     * of it. Same kernels the transcription uses, so it tracks the thing that
     * actually matters rather than a synthetic score.
     */
    suspend fun benchmarkGflops(threads: Int): Result<Double> = withContext(Dispatchers.Default) {
        runCatching {
            WhisperNative.ensureLoaded().getOrThrow()
            val report = WhisperNative.benchMatmul(threads)
            val values = Regex("""([0-9]+\.?[0-9]*)\s*GFLOPS""").findAll(report)
                .mapNotNull { it.groupValues[1].toDoubleOrNull() }
                .toList()
            if (values.isEmpty()) throw IllegalStateException("לא הצלחתי לקרוא את תוצאת המדידה")
            values.max()
        }
    }
}
