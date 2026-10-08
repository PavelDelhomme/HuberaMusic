package ovh.delhomme.ytmusic.player

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CancellationPolicyTest {
    @Test
    fun compositionCancelIsScopeCancellation() {
        assertTrue(CancellationPolicy.isScopeCancellation(CancellationException("The coroutine left the scope")))
        assertTrue(CancellationPolicy.isScopeCancellation(CancellationException("Job was cancelled")))
        assertTrue(
            CancellationPolicy.isScopeCancellation(
                RuntimeException("wrap", CancellationException("left the scope")),
            ),
        )
    }

    @Test
    fun realErrorsAreNotCancellation() {
        assertFalse(CancellationPolicy.isScopeCancellation(IllegalStateException("ExoPlayer error")))
        assertFalse(CancellationPolicy.isScopeCancellation(null))
    }

    @Test(expected = CancellationException::class)
    fun rethrowDoesNotSwallowScopeCancel() {
        CancellationPolicy.rethrowIfCancelled(CancellationException("The coroutine left the scope"))
    }
}
