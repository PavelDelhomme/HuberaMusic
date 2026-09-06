package ovh.delhomme.ytmusic.auth

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import ovh.delhomme.ytmusic.DeviceLoginDeepLink
import ovh.delhomme.ytmusic.MainActivity

/** Parse + génération QR pour le login appareil (approve / claim). */
object DeviceLoginQr {
    fun parse(raw: String?): DeviceLoginDeepLink? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return MainActivity.parseDeviceLogin(Uri.parse(text))
    }

    fun bitmap(content: String, sizePx: Int = 512): Bitmap {
        val hints = mapOf(EncodeHintType.MARGIN to 1)
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
        val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        for (x in 0 until sizePx) {
            for (y in 0 until sizePx) {
                bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
            }
        }
        return bmp
    }
}
