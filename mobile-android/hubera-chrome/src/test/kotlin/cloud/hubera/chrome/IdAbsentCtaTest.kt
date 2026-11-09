package cloud.hubera.chrome

import org.junit.Assert.assertEquals
import org.junit.Test

class IdAbsentCtaTest {
    @Test
    fun presentOpensTheApp() {
        assertEquals(IdAbsentCta.Action.OPEN_APP, IdAbsentCta.choose(idInstalled = true))
    }

    @Test
    fun absentOffersOta() {
        assertEquals(IdAbsentCta.Action.OFFER_OTA, IdAbsentCta.choose(idInstalled = false))
    }
}
