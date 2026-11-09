package ovh.delhomme.ytmusic.data

import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONObject
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Historique batterie **sur une fenêtre**, pas un instantané.
 * Le % Android ne bouge pas en 1 s : un mail « 0 % » au tap Debug n’a aucun sens.
 * Échantillons ~30 s, conservés 2 h, rapport par défaut = **10 min**.
 */
object BatteryHistory {
    const val WINDOW_MS = 10 * 60_000L
    const val SAMPLE_MS = 30_000L
    const val RETAIN_MS = 2 * 60 * 60_000L
    /** %/h affiché comme fiable seulement si la fenêtre atteint ~8 min. */
    const val MIN_RELIABLE_MS = 8 * 60_000L
    private const val MIN_GAP_MS = 12_000L

    data class Sample(
        val ts: Long,
        val pct: Int,
        val uah: Long?,
        val ua: Int?,
        val tempC: Double?,
        val charging: Boolean,
    )

    data class Report(
        val session: Map<String, Any?>,
        val stats: Map<String, Any?>,
        val notes: String,
        val samples: Map<String, String>,
        val reliable: Boolean,
        val durationSec: Int,
    )

    @Volatile private var started = false
    private val lock = Any()
    private val ring = ArrayDeque<Sample>()
    private var lastWriteElapsed = 0L
    private var file: File? = null
    private val handler = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null
    private var app: Context? = null

    fun start(context: Context) {
        if (started) return
        started = true
        val ctx = context.applicationContext
        app = ctx
        file = File(ctx.filesDir, "battery-history.jsonl")
        loadFromDisk()
        record(ctx, force = true)
        val tick = object : Runnable {
            override fun run() {
                record(ctx, force = false)
                handler.postDelayed(this, SAMPLE_MS)
            }
        }
        ticker = tick
        handler.postDelayed(tick, SAMPLE_MS)
        AppLog.i("BatteryHistory", "start samples=${size()} window=${WINDOW_MS / 1000}s")
    }

    fun size(): Int = synchronized(lock) { ring.size }

    fun record(context: Context, force: Boolean = false, sticky: Intent? = null) {
        val nowElapsed = SystemClock.elapsedRealtime()
        if (!force && lastWriteElapsed > 0 && nowElapsed - lastWriteElapsed < MIN_GAP_MS) return
        lastWriteElapsed = nowElapsed
        val sample = capture(context.applicationContext, sticky)
        synchronized(lock) {
            ring.addLast(sample)
            pruneLocked(System.currentTimeMillis())
        }
        appendDisk(sample)
    }

    fun window(windowMs: Long = WINDOW_MS): List<Sample> {
        val cutoff = System.currentTimeMillis() - windowMs
        return synchronized(lock) { ring.filter { it.ts >= cutoff } }
    }

    fun buildReport(context: Context, windowMs: Long = WINDOW_MS): Report {
        record(context, force = true)
        val samples = window(windowMs)
        val now = System.currentTimeMillis()
        val first = samples.firstOrNull()
        val last = samples.lastOrNull()
        val durationMs = if (first != null && last != null) (last.ts - first.ts).coerceAtLeast(0) else 0L
        val durationSec = (durationMs / 1000L).toInt()
        val hours = durationMs / 3_600_000.0
        val charged = samples.any { it.charging } || last?.charging == true
        val levelStart = first?.pct
        val levelEnd = last?.pct
        val levelDelta = if (levelStart != null && levelEnd != null) levelStart - levelEnd else null
        val uah0 = first?.uah
        val uah1 = last?.uah
        val mahDelta = if (uah0 != null && uah1 != null && uah0 > 0 && uah1 > 0) {
            (uah0 - uah1) / 1000.0
        } else {
            null
        }
        val reliable = durationMs >= MIN_RELIABLE_MS && samples.size >= 4 && !charged
        val percentPerHour = if (reliable && levelDelta != null && hours > 0.02) {
            round1(levelDelta / hours)
        } else {
            null
        }
        val mAhPerHour = if (durationMs >= 90_000 && mahDelta != null && hours > 0.02 && !charged) {
            round1(mahDelta / hours)
        } else {
            null
        }
        val mins = durationSec / 60.0
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(now))
        val notes = buildString {
            if (durationMs < 60_000L) {
                append("Fenêtre trop courte (${durationSec}s) : ce n’est PAS une conso. ")
                append("Le % Android ne descend pas en 1 seconde — un tap Debug ne peut pas afficher 0 % « consommé ». ")
                append("Laisse Hubera Music tourner ~10 min (lecture) puis renvoie.")
            } else if (!reliable) {
                append("Fenêtre ${fmtDur(durationSec)}")
                if (charged) append(" (charge détectée — %/h drain non calculé)")
                else append(" (< 8 min : %/h non fiable, le % Android bouge par palier)")
                append(". mAh via charge_counter si dispo. Relance après 10 min pour un %/h cohérent.")
            } else {
                append("Fenêtre ${fmtDur(durationSec)} (${samples.size} échantillons, ~30 s). ")
                append("Conso Hubera Music sur cette période, pas un instantané.")
            }
        }
        val csv = buildString {
            appendLine("ts,iso,pct,uah,ua,temp_c,charging")
            samples.takeLast(40).forEach { s ->
                append(s.ts).append(',')
                append(iso(s.ts)).append(',')
                append(s.pct).append(',')
                append(s.uah ?: "").append(',')
                append(s.ua ?: "").append(',')
                append(s.tempC ?: "").append(',')
                append(if (s.charging) 1 else 0).append('\n')
            }
        }
        val session = mapOf(
            "stamp" to stamp,
            "durationSec" to durationSec,
            "sampleSec" to (SAMPLE_MS / 1000).toInt(),
            "windowMs" to windowMs,
            "sampleCount" to samples.size,
            "unplugged" to !charged,
            "reliable" to reliable,
        )
        val stats = mutableMapOf<String, Any?>(
            "levelStart" to levelStart,
            "levelEnd" to levelEnd,
            "levelDelta" to levelDelta,
            "tempStartC" to first?.tempC,
            "tempEndC" to last?.tempC,
            "chargeCounterStart" to uah0,
            "chargeCounterEnd" to uah1,
            "mAhDelta" to mahDelta?.let { round1(it) },
            "mAhPerHour" to mAhPerHour,
            "percentPerHour" to percentPerHour,
            "currentNowUa" to last?.ua,
            "reliable" to reliable,
        )
        return Report(
            session = session,
            stats = stats,
            notes = notes,
            samples = mapOf(
                "battery.csv" to csv.take(12_000),
                "resume" to "window=${fmtDur(durationSec)} samples=${samples.size} reliable=$reliable charged=$charged mins=${round1(mins)}",
            ),
            reliable = reliable,
            durationSec = durationSec,
        )
    }

    private fun capture(ctx: Context, stickyIn: Intent?): Sample {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val sticky = stickyIn ?: ctx.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        var pct = BatterySaver.batteryPercent()
        var charging = BatterySaver.isCharging()
        var tempC: Double? = null
        if (sticky != null) {
            val level = sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = sticky.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
            if (level >= 0) pct = ((level * 100f) / scale).toInt().coerceIn(0, 100)
            val status = sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL ||
                sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
            val tempRaw = sticky.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            if (tempRaw != Int.MIN_VALUE) tempC = tempRaw / 10.0
        }
        val uah = runCatching {
            val v = bm?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER) ?: Long.MIN_VALUE
            if (v == Long.MIN_VALUE || v <= 0) null else v
        }.getOrNull()
        val ua = runCatching {
            val v = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) ?: Int.MIN_VALUE
            if (v == Int.MIN_VALUE) null else v
        }.getOrNull()
        return Sample(System.currentTimeMillis(), pct, uah, ua, tempC, charging)
    }

    private fun pruneLocked(now: Long) {
        val cut = now - RETAIN_MS
        while (ring.isNotEmpty() && ring.first().ts < cut) ring.removeFirst()
    }

    private fun loadFromDisk() {
        val f = file ?: return
        if (!f.isFile) return
        val cut = System.currentTimeMillis() - RETAIN_MS
        runCatching {
            f.useLines { lines ->
                synchronized(lock) {
                    ring.clear()
                    lines.forEach { line ->
                        val s = parseLine(line) ?: return@forEach
                        if (s.ts >= cut) ring.addLast(s)
                    }
                }
            }
        }
    }

    private fun appendDisk(sample: Sample) {
        val f = file ?: return
        runCatching {
            f.appendText(toLine(sample) + "\n")
            if (f.length() > 400_000) rewriteDisk()
        }
    }

    private fun rewriteDisk() {
        val f = file ?: return
        val body = synchronized(lock) { ring.joinToString("\n") { toLine(it) } }
        runCatching { f.writeText(if (body.isEmpty()) "" else body + "\n") }
    }

    private fun toLine(s: Sample): String {
        val o = JSONObject()
        o.put("t", s.ts)
        o.put("p", s.pct)
        if (s.uah != null) o.put("uah", s.uah)
        if (s.ua != null) o.put("ua", s.ua)
        if (s.tempC != null) o.put("tc", s.tempC)
        o.put("chg", s.charging)
        return o.toString()
    }

    private fun parseLine(line: String): Sample? {
        if (line.isBlank()) return null
        return runCatching {
            val o = JSONObject(line)
            Sample(
                ts = o.optLong("t"),
                pct = o.optInt("p"),
                uah = if (o.has("uah")) o.optLong("uah") else null,
                ua = if (o.has("ua")) o.optInt("ua") else null,
                tempC = if (o.has("tc")) o.optDouble("tc") else null,
                charging = o.optBoolean("chg"),
            )
        }.getOrNull()
    }

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0

    private fun fmtDur(sec: Int): String {
        if (sec < 60) return "${sec}s"
        val m = sec / 60
        val s = sec % 60
        return if (s == 0) "${m} min" else "${m} min ${s}s"
    }

    private fun iso(ts: Long): String =
        SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(ts))
}
