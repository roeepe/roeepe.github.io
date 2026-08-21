package io.github.roeepe.ivrit.estimator

import io.github.roeepe.ivrit.model.ModelStore
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.pow

/**
 * Says what a job will cost on this phone before it starts: how long, how
 * likely it is to fail and why, and what it will do to the device while it runs.
 *
 * The native app answers this better than the browser one could. Memory comes
 * from the system's own low-memory threshold rather than a fraction-of-RAM
 * guess; the thermal state is read directly instead of inferred from elapsed
 * time; throughput is measured with the same ggml kernels that do the
 * transcribing. PRIORS is what remains unmeasured, and [Calibration] replaces
 * each entry with this device's own numbers after the first real run.
 */
object Estimator {

    object PRIORS {
        /** ggml matmul GFLOPS on the reference phone: a 2023-class 8-core arm64 SoC. */
        const val REF_GFLOPS = 40.0
        /** Realtime factor for large-v3-turbo at q5 on that reference device. */
        const val REF_RTF = 2.0
        /** Throughput grows slower than raw FLOPS — decode is memory-bound as much as ALU-bound. */
        const val SCALE_EXPONENT = 0.8

        const val MODEL_LOAD_SEC_PER_GB = 6.0
        const val DECODE_RTF = 120.0        // MediaCodec is hardware-backed and far faster than realtime

        /** Sustained SoC draw while all big cores are decoding. */
        const val WATTS = 4.1
        const val PHONE_WH = 15.4

        // Thermal decay, applied on top of whatever derate the phone already reports.
        const val THERMAL_ONSET_SEC = 120.0
        const val THERMAL_TAU_SEC = 240.0
        const val THERMAL_FLOOR = 0.55

        const val COLAB_ALLOC_SEC = 50.0
        const val COLAB_SETUP_SEC = 105.0
        const val COLAB_T4_RTF = 11.0
        const val COLAB_NO_GPU_P = 0.22
    }

    enum class Route { ON_DEVICE, COLAB }

    data class Phase(val label: String, val seconds: Double)

    data class Risk(val id: String, val probability: Double, val label: String, val detail: String, val fix: String)

    data class Impact(
        val level: String,               // "low" | "high" | "severe"
        val summary: String,
        val batteryPercent: Double,
        val batteryPercentPerHour: Double,
        val batteryEmptyAfterSec: Double?,
        val heat: String,
        val coresUsed: Int,
    )

    data class Estimate(
        val route: Route,
        val phases: List<Phase>,
        val p50Sec: Double,
        val p90Sec: Double,
        val realtimeFactor: Double,
        val risks: List<Risk>,
        val totalRisk: Double,
        val impact: Impact,
        val calibrated: Boolean,
        val basis: String,
    )

    /**
     * Wall time to push [audioSec] through a decoder running at [rtf], with the
     * SoC pulling clocks back as it heats. Integrated rather than closed-form
     * because the derate compounds.
     */
    fun withThermalDecay(audioSec: Double, rtf: Double, startingDerate: Double): Pair<Double, Double> {
        var wall = 0.0
        var done = 0.0
        val step = 15.0
        while (done < audioSec) {
            val chunk = min(step, audioSec - done)
            val hot = (wall - PRIORS.THERMAL_ONSET_SEC).coerceAtLeast(0.0)
            val decay = PRIORS.THERMAL_FLOOR + (1 - PRIORS.THERMAL_FLOOR) * exp(-hot / PRIORS.THERMAL_TAU_SEC)
            wall += chunk / (rtf * decay * startingDerate)
            done += chunk
        }
        val idealWall = audioSec / (rtf * startingDerate)
        return wall to (wall - idealWall)
    }

    private fun combine(ps: List<Double>): Double =
        1 - ps.fold(1.0) { acc, p -> acc * (1 - p.coerceIn(0.0, 0.995)) }

    private fun logistic(x: Double, mid: Double, width: Double) = 1 / (1 + exp(-(x - mid) / (width / 2)))

    fun onDevice(
        audioSec: Double,
        variant: ModelStore.Variant,
        modelDownloaded: Boolean,
        alreadyDownloadedBytes: Long,
        facts: DeviceFacts,
        benchGflops: Double?,
        calibration: Calibration.RouteStats?,
    ): Estimate {
        val measured = calibration?.realtimeFactor
        val rtf = measured
            ?: (PRIORS.REF_RTF * ((benchGflops ?: PRIORS.REF_GFLOPS) / PRIORS.REF_GFLOPS).pow(PRIORS.SCALE_EXPONENT))
        val derate = DeviceProbe.thermalDerate(facts.thermalStatus)

        val phases = mutableListOf<Phase>()
        if (!modelDownloaded) {
            val remaining = (variant.sizeBytes - alreadyDownloadedBytes).coerceAtLeast(0)
            val rate = facts.network.downBytesPerSec.takeIf { it > 1000 } ?: 1_500_000.0
            phases += Phase("הורדת המודל (${variant.label})", remaining / rate)
        }
        phases += Phase("טעינת המודל", variant.sizeBytes / 1e9 * PRIORS.MODEL_LOAD_SEC_PER_GB)
        phases += Phase("פענוח האודיו", audioSec / PRIORS.DECODE_RTF)
        val (inferSec, thermalLoss) = withThermalDecay(audioSec, rtf, derate)
        phases += Phase("תמלול", inferSec)

        val total = phases.sumOf { it.seconds }
        val risks = mutableListOf<Risk>()

        // Memory: the model is memory-mapped, so the pressure is real but not
        // the whole file at once. The system's own threshold is the yardstick.
        val need = variant.sizeBytes * 6 / 10 + 220L * 1024 * 1024
        val budget = facts.memoryBudgetBytes
        risks += Risk(
            "memory",
            logistic(need.toDouble() / budget, 0.9, 0.6),
            "המערכת תסגור את האפליקציה בגלל זיכרון",
            "דרוש ~${gb(need)} GB, פנוי מעל סף הסכנה ~${gb(budget)} GB" +
                if (facts.isLowMemory) " · המכשיר כבר במצב זיכרון נמוך" else "",
            "לסגור אפליקציות אחרות, או לבחור וריאנט קטן יותר של המודל",
        )

        if (!modelDownloaded) {
            val remaining = variant.sizeBytes - alreadyDownloadedBytes
            risks += Risk(
                "storage",
                logistic(remaining.toDouble() / facts.freeStorageBytes.coerceAtLeast(1), 0.85, 0.4),
                "אין מקום לשמור את המודל",
                "צריך ${gb(remaining)} GB, פנוי ${gb(facts.freeStorageBytes)} GB",
                "לפנות מקום, או לבחור וריאנט קטן יותר",
            )
            val netRisk = when {
                !facts.network.connected -> 0.95
                facts.network.wifi -> 0.04
                facts.network.metered -> 0.16
                else -> 0.10
            }
            risks += Risk(
                "download", netRisk, "ההורדה תיקטע",
                "${gb(remaining)} GB על ${facts.network.label}",
                "ההורדה מתחדשת מהנקודה שנעצרה, אז אפשר פשוט לנסות שוב",
            )
        }

        // Thermal: unlike the browser, this is the phone's own reported state.
        if (facts.thermalStatus > 0) {
            risks += Risk(
                "thermal",
                min(0.35, 0.10 * facts.thermalStatus),
                "ויסות תרמי יאט את הריצה",
                "המכשיר כרגע ${facts.thermalLabel}" +
                    (facts.batteryTempC?.let { " · סוללה ${"%.1f".format(it)}°" } ?: ""),
                "להוריד מהמטען, להוציא מהכיס, ולתת לו להתקרר לפני הרצה ארוכה",
            )
        }

        val level = facts.batteryPercent
        val drainPct = PRIORS.WATTS * (total / 3600) / PRIORS.PHONE_WH * 100
        if (level != null && !facts.isCharging) {
            risks += Risk(
                "battery",
                logistic(drainPct - level, -8.0, 20.0),
                "הסוללה תיגמר לפני הסוף",
                "$level% עכשיו, צריכה משוערת ${drainPct.toInt()}%",
                "לחבר למטען — זה גם מקטין את הוויסות התרמי",
            )
        }

        // Long jobs get killed in the background; a foreground service is the answer.
        risks += Risk(
            "background",
            1 - exp(-total / 5400.0),
            "המערכת תעצור את העבודה ברקע",
            "ריצה של ${(total / 60).toInt()} דקות",
            "התמלול רץ ב-foreground service עם התראה, וממשיך מאותה נקודה אם נקטע",
        )

        val kept = risks.filter { it.probability > 0.005 }.sortedByDescending { it.probability }
        val cores = min(8, (facts.cores - 1).coerceAtLeast(2))

        return Estimate(
            route = Route.ON_DEVICE,
            phases = phases,
            p50Sec = total,
            p90Sec = total * if (measured != null) 1.25 else 1.8,
            realtimeFactor = rtf,
            risks = kept,
            totalRisk = combine(kept.map { it.probability }),
            impact = Impact(
                level = if (facts.cores <= 4) "severe" else "high",
                summary = "$cores מתוך ${facts.cores} ליבות תפוסות. המכשיר יגיב לאט, יתחמם, " +
                    "והמסך יכול להישאר כבוי — התמלול ממשיך ברקע",
                batteryPercent = min(100.0, drainPct),
                batteryPercentPerHour = PRIORS.WATTS / PRIORS.PHONE_WH * 100,
                batteryEmptyAfterSec = if (level != null && !facts.isCharging && drainPct > level)
                    level / (PRIORS.WATTS / PRIORS.PHONE_WH * 100) * 3600 else null,
                heat = if (thermalLoss > 30) "יתחמם משמעותית — ${(thermalLoss / 60).toInt()} דק׳ מהזמן הן בגלל ויסות תרמי"
                       else "חימום קל",
                coresUsed = cores,
            ),
            calibrated = measured != null,
            basis = if (measured != null)
                "מכויל לפי ${calibration?.runs} ריצות במכשיר הזה"
            else if (benchGflops != null)
                "מבוסס על מדידת ggml במכשיר (${"%.1f".format(benchGflops)} GFLOPS)"
            else "הערכה ראשונית — תתכייל אחרי הריצה הראשונה",
        )
    }

    fun colab(
        audioSec: Double,
        fileBytes: Long,
        facts: DeviceFacts,
        calibration: Calibration.RouteStats?,
    ): Estimate {
        val rtf = calibration?.realtimeFactor ?: PRIORS.COLAB_T4_RTF
        val up = facts.network.upBytesPerSec.takeIf { it > 1000 } ?: 400_000.0
        val uploadSec = fileBytes / up

        val phases = listOf(
            Phase("העלאה ל-Google Drive", uploadSec),
            Phase("הקצאת מכונה עם GPU", PRIORS.COLAB_ALLOC_SEC),
            Phase("התקנה ומשקולות", PRIORS.COLAB_SETUP_SEC),
            Phase("תמלול על ה-GPU", audioSec / rtf),
            Phase("החזרת התמלול", 4.0),
        )
        val total = phases.sumOf { it.seconds }

        val risks = listOfNotNull(
            Risk("nogpu", PRIORS.COLAB_NO_GPU_P, "Colab לא יקצה GPU",
                "בחשבון חינמי זה קורה בשעות עומס", "לנסות שוב מאוחר יותר"),
            Risk("upload", if (facts.network.wifi) 0.05 else 0.18, "ההעלאה תיכשל",
                "${mb(fileBytes)} MB על ${facts.network.label}",
                "ההעלאה מתחדשת מהנקודה שנעצרה"),
            if (!facts.network.connected)
                Risk("offline", 0.95, "אין חיבור לרשת", "המסלול הזה דורש אינטרנט", "להתחבר, או להשתמש בתמלול על המכשיר")
            else null,
        ).filter { it.probability > 0.005 }.sortedByDescending { it.probability }

        return Estimate(
            route = Route.COLAB,
            phases = phases,
            p50Sec = total,
            p90Sec = total * 1.6,
            realtimeFactor = rtf,
            risks = risks,
            totalRisk = combine(risks.map { it.probability }),
            impact = Impact(
                level = "low",
                summary = "הנייד רק מעלה את הקובץ (${uploadSec.toInt()} שנ׳) ואז ממתין — " +
                    "אפשר לנעול את המסך ולהמשיך להשתמש במכשיר רגיל",
                batteryPercent = min(100.0, 1.3 * (total / 3600) / PRIORS.PHONE_WH * 100),
                batteryPercentPerHour = 1.3 / PRIORS.PHONE_WH * 100,
                batteryEmptyAfterSec = null,
                heat = "בלי חימום ממשי",
                coresUsed = 0,
            ),
            calibrated = calibration?.realtimeFactor != null,
            basis = if (calibration?.realtimeFactor != null)
                "מכויל לפי ${calibration.runs} ריצות" else "הערכה ראשונית",
        )
    }

    /**
     * Ranks by expected cost, not raw speed: a route that fails half the time
     * costs two attempts, and tying up the phone has a price of its own.
     */
    fun recommend(estimates: List<Estimate>): Estimate = estimates.minByOrNull { e ->
        val attempts = 1 / (1 - e.totalRisk).coerceAtLeast(0.15)
        val impactPenalty = e.p50Sec * when (e.impact.level) {
            "severe" -> 0.9; "high" -> 0.5; else -> 0.0
        }
        e.p50Sec * attempts + impactPenalty
    } ?: estimates.first()

    private fun gb(bytes: Long) = "%.2f".format(bytes / 1e9)
    private fun mb(bytes: Long) = (bytes / 1e6).toInt()
}
