package top.rpone.qinlinopen.ui.main

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.zIndex
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import kotlinx.coroutines.launch
import top.rpone.qinlinopen.R
import top.rpone.qinlinopen.data.DoorKey
import top.rpone.qinlinopen.widget.DoorWidgetProvider

@Suppress("UNUSED_PARAMETER")
@Composable
fun MainScreen(
  onItemClick: (NavKey) -> Unit,
  modifier: Modifier = Modifier,
  viewModel: MainScreenViewModel = viewModel(),
) {
  val state by viewModel.uiState.collectAsStateWithLifecycle()
  val context = LocalContext.current
  LaunchedEffect(viewModel) {
    viewModel.messages.collect { message ->
      Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
  }
  MainScreen(
    state = state,
    onPhoneChange = viewModel::setPhone,
    onCodeChange = viewModel::setSecurityCode,
    onSendCode = viewModel::sendSecurityCode,
    onLogin = viewModel::login,
    onRefresh = viewModel::refreshDoors,
    onOpenDoor = viewModel::openDoor,
    onMoveDoor = viewModel::moveDoor,
    onDoorOrderChanged = viewModel::persistDoorOrder,
    onLogout = viewModel::logout,
    modifier = modifier,
  )
}

@Composable
internal fun MainScreen(
  state: MainScreenUiState,
  onPhoneChange: (String) -> Unit,
  onCodeChange: (String) -> Unit,
  onSendCode: () -> Unit,
  onLogin: () -> Unit,
  onRefresh: () -> Unit,
  onOpenDoor: (DoorKey) -> Unit,
  onMoveDoor: (Int, Int) -> Unit,
  onDoorOrderChanged: () -> Unit,
  onLogout: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val listState = rememberLazyListState()
  val coroutineScope = rememberCoroutineScope()
  val reorderState = remember(listState) { DoorReorderState(listState) }
  LazyColumn(
    modifier = modifier.fillMaxSize(),
    state = listState,
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    item {
      Text("QinlinOpen", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
    }

    if (!state.loggedIn) {
      item {
        Text("登录", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
      }
      item {
        OutlinedTextField(
          value = state.phone,
          onValueChange = onPhoneChange,
          modifier = Modifier.fillMaxWidth(),
          enabled = !state.busy,
          label = { Text("手机号") },
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
          singleLine = true,
        )
      }
      item {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          OutlinedTextField(
            value = state.securityCode,
            onValueChange = onCodeChange,
            modifier = Modifier.weight(1f),
            enabled = !state.busy,
            label = { Text("短信验证码") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
          )
          Spacer(Modifier.width(8.dp))
          OutlinedButton(onClick = onSendCode, enabled = !state.busy) { Text("发送") }
        }
      }
      item {
        Button(
          onClick = onLogin,
          modifier = Modifier.fillMaxWidth().height(52.dp),
          enabled = !state.busy,
        ) {
          Text("登录并读取钥匙")
        }
      }
    } else {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text("钥匙", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
          OutlinedButton(onClick = onRefresh, enabled = !state.busy) { Text("刷新") }
        }
      }

      itemsIndexed(state.doors, key = { _, key -> key.stableId }) { index, key ->
        val itemIndex = FIRST_DOOR_ITEM_INDEX + index
        val dragging = reorderState.draggedItemIndex == itemIndex
        val visual =
          when (key.stableId) {
            state.openingDoorId -> DoorKeyVisual.Loading
            state.successfulDoorId -> DoorKeyVisual.Success
            else -> DoorKeyVisual.Normal
          }
        DoorKeyButton(
          key = key,
          enabled = !state.busy,
          onClick = { onOpenDoor(key) },
          visual = visual,
          modifier =
            Modifier.zIndex(if (dragging) 1f else 0f).graphicsLayer {
              translationY = if (dragging) reorderState.draggedDistance else 0f
            },
          dragHandle = {
            Icon(
              painter = painterResource(R.drawable.ic_drag_handle),
              contentDescription = "长按拖动排序",
              tint = MaterialTheme.colorScheme.onSurfaceVariant,
              modifier =
                Modifier.size(40.dp).padding(8.dp).pointerInput(key.stableId, state.busy) {
                  if (!state.busy) {
                    detectDragGesturesAfterLongPress(
                      onDragStart = { reorderState.start(itemIndex) },
                      onDragCancel = {
                        if (reorderState.end()) onDoorOrderChanged()
                      },
                      onDragEnd = {
                        if (reorderState.end()) onDoorOrderChanged()
                      },
                      onDrag = { change, dragAmount ->
                        change.consume()
                        val scroll =
                          reorderState.dragBy(
                            delta = dragAmount.y,
                            doorCount = state.doors.size,
                            onMove = onMoveDoor,
                          )
                        if (scroll != 0f) {
                          coroutineScope.launch { listState.scrollBy(scroll) }
                        }
                      },
                    )
                  }
                },
            )
          },
        )
      }

      item {
        OutlinedButton(
          onClick = {
            val manager = AppWidgetManager.getInstance(context)
            val supported =
              Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                manager.isRequestPinAppWidgetSupported
            if (!supported) {
              Toast.makeText(context, "请从桌面的小组件列表添加 QinlinOpen", Toast.LENGTH_LONG).show()
            } else {
              context.startActivity(
                Intent(Intent.ACTION_MAIN)
                  .addCategory(Intent.CATEGORY_HOME)
                  .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
              )
              val applicationContext = context.applicationContext
              Handler(Looper.getMainLooper()).postDelayed(
                {
                  val requested =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                      AppWidgetManager.getInstance(applicationContext).requestPinAppWidget(
                        ComponentName(applicationContext, DoorWidgetProvider::class.java),
                        null,
                        null,
                      )
                    } else {
                      false
                    }
                  if (!requested) {
                    Toast.makeText(
                        applicationContext,
                        "请从桌面的小组件列表添加 QinlinOpen",
                        Toast.LENGTH_LONG,
                      )
                      .show()
                  }
                },
                350,
              )
            }
          },
          modifier = Modifier.fillMaxWidth(),
          enabled = !state.busy && state.doors.isNotEmpty(),
        ) {
          Text("添加桌面小组件")
        }
      }

      item {
        HorizontalDivider()
        Spacer(Modifier.height(4.dp))
        OutlinedButton(onClick = onLogout, enabled = !state.busy) { Text("退出登录") }
      }
    }

  }
}

@Composable
internal fun DoorKeyButton(
  key: DoorKey,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  visual: DoorKeyVisual = DoorKeyVisual.Normal,
  dragHandle: (@Composable () -> Unit)? = null,
) {
  Card(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.fillMaxWidth(),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(modifier = Modifier.size(24.dp), contentAlignment = Alignment.Center) {
        when (visual) {
          DoorKeyVisual.Normal ->
            Icon(
              painter = painterResource(R.drawable.ic_lock_open),
              contentDescription = null,
              tint = MaterialTheme.colorScheme.onSurface,
            )
          DoorKeyVisual.Loading ->
            CircularProgressIndicator(
              modifier = Modifier.size(22.dp),
              strokeWidth = 2.dp,
              color = MaterialTheme.colorScheme.onSurface,
            )
          DoorKeyVisual.Success ->
            Icon(
              painter = painterResource(R.drawable.ic_check_circle),
              contentDescription = null,
              tint = MaterialTheme.colorScheme.onSurface,
            )
        }
      }
      Spacer(Modifier.width(12.dp))
      Column(modifier = Modifier.weight(1f)) {
        Text(key.doorName, fontWeight = FontWeight.Medium)
        if (key.communityName.isNotBlank()) {
          Text(
            key.communityName,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
          )
        }
      }
      dragHandle?.invoke()
    }
  }
}

internal enum class DoorKeyVisual {
  Normal,
  Loading,
  Success,
}

private class DoorReorderState(private val listState: LazyListState) {
  var draggedItemIndex by mutableIntStateOf(-1)
    private set

  var draggedDistance by mutableFloatStateOf(0f)
    private set

  private var moved = false

  fun start(itemIndex: Int) {
    draggedItemIndex = itemIndex
    draggedDistance = 0f
    moved = false
  }

  fun dragBy(delta: Float, doorCount: Int, onMove: (Int, Int) -> Unit): Float {
    val draggedItem =
      listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == draggedItemIndex }
        ?: return 0f
    draggedDistance += delta

    val startOffset = draggedItem.offset + draggedDistance
    val endOffset = startOffset + draggedItem.size
    val doorRange = FIRST_DOOR_ITEM_INDEX until (FIRST_DOOR_ITEM_INDEX + doorCount)
    val target =
      listState.layoutInfo.visibleItemsInfo.firstOrNull { candidate ->
        candidate.index in doorRange &&
          candidate.index != draggedItemIndex &&
          if (draggedDistance > 0) {
            endOffset > candidate.offset + candidate.size / 2f && draggedItem.offset < candidate.offset
          } else {
            startOffset < candidate.offset + candidate.size / 2f && draggedItem.offset > candidate.offset
          }
      }

    if (target != null) {
      onMove(
        draggedItemIndex - FIRST_DOOR_ITEM_INDEX,
        target.index - FIRST_DOOR_ITEM_INDEX,
      )
      draggedItemIndex = target.index
      draggedDistance += draggedItem.offset - target.offset
      moved = true
    }

    val layout = listState.layoutInfo
    return when {
        startOffset < layout.viewportStartOffset -> startOffset - layout.viewportStartOffset
        endOffset > layout.viewportEndOffset -> endOffset - layout.viewportEndOffset
        else -> 0f
      }
      .coerceIn(-32f, 32f)
  }

  fun end(): Boolean {
    val wasMoved = moved
    draggedItemIndex = -1
    draggedDistance = 0f
    moved = false
    return wasMoved
  }
}

private const val FIRST_DOOR_ITEM_INDEX = 2
