package ovh.delhomme.ytmusic.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CoverStoreTest {
    @Test
    fun seenCoverIsFoundAgainAndABlankIdIsIgnored() {
        val dir = File.createTempFile("covers", "").apply {
            delete()
            mkdirs()
        }
        val bytes = ByteArray(1200) { 1 }
        val written = CoverStore.write(dir, "dQw4w9WgXcQ", bytes)
        assertNotNull(written)
        val again = CoverStore.peek(dir, "dQw4w9WgXcQ")
        assertEquals(written!!.absolutePath, again?.absolutePath)
        assertTrue(again!!.length() >= 800)
        assertNull(CoverStore.safeName("  "))
        assertNull(CoverStore.write(dir, "x", ByteArray(10)))
        dir.deleteRecursively()
    }

    @Test
    fun onlyTheRecentlySeenCoversStayOnDisk() {
        val dir = File.createTempFile("covers-lru", "").apply {
            delete()
            mkdirs()
        }
        val bytes = ByteArray(900) { 2 }
        repeat(5) { i ->
            val file = CoverStore.write(dir, "track-$i", bytes)
            file?.setLastModified(1_000L + i * 1_000L)
        }
        CoverStore.evict(dir, 3)
        val left = dir.listFiles()?.map { it.name }?.toSet().orEmpty()
        assertEquals(3, left.size)
        assertTrue("track-4.jpg" in left)
        assertTrue("track-0.jpg" !in left)
        dir.deleteRecursively()
    }
}
