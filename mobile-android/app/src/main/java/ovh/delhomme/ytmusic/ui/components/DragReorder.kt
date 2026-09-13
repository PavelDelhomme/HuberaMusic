package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.zIndex
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Réordonner une LazyColumn style YouTube Music :
 * glisser la poignée (ou long-press) → l’item suit le doigt, swap fluide, auto-scroll.
 *
 * [index] = index dans la liste métier (pas forcément l’index LazyColumn s’il y a des headers).
 * [itemKey] = clé LazyColumn de l’item (pour retrouver le layout).
 */
class DragReorderState internal constructor(
    val listState: LazyListState,
    private val scope: CoroutineScope,
) {
    var onMove: (from: Int, to: Int) -> Unit = { _, _ -> }
    var onDragEnd: (() -> Unit)? = null

    var draggingIndex by mutableStateOf<Int?>(null)
        private set
    var draggingKey by mutableStateOf<Any?>(null)
        private set
    var dragOffsetY by mutableFloatStateOf(0f)
        private set
    private var fingerY = 0f
    private var scrollJob: Job? = null
    /** Clés LazyColumn autorisées au swap (exclut headers). */
    private var allowedKeys: Set<Any> = emptySet()
    private var keyToIndex: (Any) -> Int? = { null }

    val isDragging: Boolean get() = draggingIndex != null

    fun configure(
        allowedKeys: Set<Any>,
        keyToIndex: (Any) -> Int?,
    ) {
        this.allowedKeys = allowedKeys
        this.keyToIndex = keyToIndex
    }

    fun start(index: Int, key: Any, startYInViewport: Float) {
        draggingIndex = index
        draggingKey = key
        dragOffsetY = 0f
        fingerY = startYInViewport
    }

    fun dragBy(deltaY: Float) {
        if (draggingIndex == null) return
        dragOffsetY += deltaY
        fingerY += deltaY
        maybeAutoScroll()
        maybeSwap()
    }

    fun end() {
        scrollJob?.cancel()
        scrollJob = null
        draggingIndex = null
        draggingKey = null
        dragOffsetY = 0f
        onDragEnd?.invoke()
    }

    private fun maybeAutoScroll() {
        val info = listState.layoutInfo
        if (info.visibleItemsInfo.isEmpty()) return
        val edge = (info.viewportEndOffset - info.viewportStartOffset) * 0.14f
        val top = info.viewportStartOffset + edge
        val bottom = info.viewportEndOffset - edge
        val speed = when {
            fingerY < top -> -32f - (top - fingerY) * 0.1f
            fingerY > bottom -> 32f + (fingerY - bottom) * 0.1f
            else -> {
                scrollJob?.cancel()
                scrollJob = null
                return
            }
        }
        if (scrollJob?.isActive == true) return
        scrollJob = scope.launch {
            while (draggingIndex != null) {
                listState.scrollBy(speed)
                maybeSwap()
                kotlinx.coroutines.delay(16)
            }
        }
    }

    private fun maybeSwap() {
        val from = draggingIndex ?: return
        val key = draggingKey ?: return
        val info = listState.layoutInfo
        val over = info.visibleItemsInfo
            .filter { it.key in allowedKeys && it.key != key }
            .minByOrNull { abs((it.offset + it.size / 2f) - fingerY) }
            ?: return
        val mid = over.offset + over.size / 2f
        val to = keyToIndex(over.key) ?: return
        val should = (from < to && fingerY > mid) || (from > to && fingerY < mid)
        if (!should || to == from) return
        onMove(from, to)
        draggingIndex = to
        scope.launch {
            kotlinx.coroutines.delay(1)
            val newItem = listState.layoutInfo.visibleItemsInfo.find { it.key == key }
            if (newItem != null && draggingKey == key) {
                dragOffsetY = fingerY - (newItem.offset + newItem.size / 2f)
            }
        }
    }
}

@Composable
fun rememberDragReorderState(
    listState: LazyListState,
    onMove: (from: Int, to: Int) -> Unit,
    onDragEnd: (() -> Unit)? = null,
): DragReorderState {
    val scope = rememberCoroutineScope()
    val state = remember(listState) { DragReorderState(listState, scope) }
    state.onMove = onMove
    state.onDragEnd = onDragEnd
    return state
}

/** Élévation visuelle de l’item en cours de drag. */
fun Modifier.dragReorderItem(
    state: DragReorderState,
    key: Any,
): Modifier {
    val dragging = state.draggingKey == key
    return this
        .zIndex(if (dragging) 2f else 0f)
        .graphicsLayer {
            if (dragging) {
                translationY = state.dragOffsetY
                shadowElevation = 14f
                scaleX = 1.025f
                scaleY = 1.025f
                alpha = 0.97f
            }
        }
}

/** Poignée : drag immédiat (comme YTM). */
fun Modifier.dragReorderHandle(
    state: DragReorderState,
    listState: LazyListState,
    index: Int,
    key: Any,
): Modifier = pointerInput(state, key, index) {
    detectDragGestures(
        onDragStart = {
            val item = listState.layoutInfo.visibleItemsInfo.find { it.key == key }
            val startY = if (item != null) {
                item.offset + item.size / 2f
            } else {
                it.y
            }
            state.start(index, key, startY)
        },
        onDragEnd = { state.end() },
        onDragCancel = { state.end() },
        onDrag = { change, amount ->
            change.consume()
            state.dragBy(amount.y)
        },
    )
}

/** Long-press sur la ligne pour démarrer le drag. */
fun Modifier.dragReorderLongPress(
    state: DragReorderState,
    listState: LazyListState,
    index: Int,
    key: Any,
): Modifier = pointerInput(state, key, index) {
    detectDragGesturesAfterLongPress(
        onDragStart = { _: Offset ->
            val item = listState.layoutInfo.visibleItemsInfo.find { it.key == key }
            val startY = if (item != null) item.offset + item.size / 2f else 0f
            state.start(index, key, startY)
        },
        onDragEnd = { state.end() },
        onDragCancel = { state.end() },
        onDrag = { change, amount ->
            change.consume()
            state.dragBy(amount.y)
        },
    )
}
