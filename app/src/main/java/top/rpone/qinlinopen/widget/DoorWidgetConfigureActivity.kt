package top.rpone.qinlinopen.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import top.rpone.qinlinopen.data.DoorKey
import top.rpone.qinlinopen.data.QinlinApi
import top.rpone.qinlinopen.data.QinlinApiException
import top.rpone.qinlinopen.data.SecureStore
import top.rpone.qinlinopen.theme.QinlinOpenTheme
import top.rpone.qinlinopen.ui.main.DoorKeyButton

private sealed interface PickerState {
  data object Loading : PickerState

  data object LoggedOut : PickerState

  data class Ready(val doors: List<DoorKey>) : PickerState

  data class Error(val message: String) : PickerState
}

class DoorWidgetConfigureActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val appWidgetId =
      intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    val resultValue =
      Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
    setResult(Activity.RESULT_CANCELED, resultValue)
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      finish()
      return
    }

    setContent {
      QinlinOpenTheme {
        var pickerState by remember { mutableStateOf<PickerState>(PickerState.Loading) }
        var reloadCount by remember { mutableIntStateOf(0) }
        var saving by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()

        LaunchedEffect(appWidgetId, reloadCount) {
          pickerState = PickerState.Loading
          pickerState = loadKeys()
        }

        WidgetKeyPicker(
          state = pickerState,
          enabled = !saving,
          onSelect = { key ->
            if (!saving) {
              saving = true
              scope.launch {
                runCatching {
                    withContext(Dispatchers.IO) {
                      SecureStore(this@DoorWidgetConfigureActivity).saveWidgetKey(appWidgetId, key)
                    }
                  }
                  .onSuccess {
                    DoorWidgetProvider.update(this@DoorWidgetConfigureActivity, appWidgetId)
                    setResult(Activity.RESULT_OK, resultValue)
                    finish()
                  }
                  .onFailure { error ->
                    pickerState =
                      PickerState.Error(error.message?.takeIf(String::isNotBlank) ?: "保存失败")
                    saving = false
                  }
              }
            }
          },
          onRetry = { reloadCount += 1 },
          onClose = { finish() },
        )
      }
    }
  }

  private suspend fun loadKeys(): PickerState =
    withContext(Dispatchers.IO) {
      val store = SecureStore(this@DoorWidgetConfigureActivity)
      val configuration = store.load() ?: return@withContext PickerState.LoggedOut
      try {
        PickerState.Ready(
          store.orderDoors(
            QinlinApi(this@DoorWidgetConfigureActivity).loadDoorKeys(configuration.sessionId)
          )
        )
      } catch (error: Exception) {
        if (error is QinlinApiException && error.code == 401) {
          store.clear()
          PickerState.LoggedOut
        } else {
          PickerState.Error(error.message?.takeIf(String::isNotBlank) ?: "读取钥匙失败")
        }
      }
    }
}

@Composable
private fun WidgetKeyPicker(
  state: PickerState,
  enabled: Boolean,
  onSelect: (DoorKey) -> Unit,
  onRetry: () -> Unit,
  onClose: () -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth().widthIn(min = 300.dp, max = 520.dp),
    shape = MaterialTheme.shapes.extraLarge,
    tonalElevation = 6.dp,
  ) {
    Column(modifier = Modifier.padding(20.dp)) {
      Text("选择钥匙", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
      Spacer(Modifier.height(16.dp))
      when (state) {
        PickerState.Loading -> {
          Box(
            modifier = Modifier.fillMaxWidth().height(160.dp),
            contentAlignment = Alignment.Center,
          ) {
            CircularProgressIndicator(modifier = Modifier.size(36.dp))
          }
        }

        PickerState.LoggedOut -> {
          Text("请先登录")
          Spacer(Modifier.height(12.dp))
          Button(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("关闭") }
        }

        is PickerState.Ready -> {
          if (state.doors.isEmpty()) {
            Text("没有可用钥匙")
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("刷新") }
          } else {
            LazyColumn(
              modifier = Modifier.fillMaxWidth().heightIn(max = 480.dp),
              verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              items(state.doors, key = { "${it.communityId}:${it.doorControlId}" }) { key ->
                DoorKeyButton(key = key, enabled = enabled, onClick = { onSelect(key) })
              }
            }
          }
        }

        is PickerState.Error -> {
          Text(state.message)
          Spacer(Modifier.height(12.dp))
          OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("重试") }
        }
      }
    }
  }
}
