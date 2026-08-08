package top.rpone.qinlinopen.ui.main

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import top.rpone.qinlinopen.data.DoorKey
import top.rpone.qinlinopen.data.QinlinApi
import top.rpone.qinlinopen.data.QinlinApiException
import top.rpone.qinlinopen.data.SavedConfiguration
import top.rpone.qinlinopen.data.SecureStore
import top.rpone.qinlinopen.widget.DoorWidgetProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class MainScreenUiState(
  val phone: String = "",
  val securityCode: String = "",
  val loggedIn: Boolean = false,
  val busy: Boolean = false,
  val doors: List<DoorKey> = emptyList(),
  val openingDoorId: String? = null,
  val successfulDoorId: String? = null,
)

class MainScreenViewModel(application: Application) : AndroidViewModel(application) {
  private val api = QinlinApi(application)
  private val store = SecureStore(application)
  private var configuration: SavedConfiguration? = store.load()
  private val _uiState =
    MutableStateFlow(
      MainScreenUiState(
        phone = configuration?.phone.orEmpty(),
        loggedIn = configuration != null,
      )
    )
  val uiState: StateFlow<MainScreenUiState> = _uiState.asStateFlow()
  private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 2)
  val messages: SharedFlow<String> = _messages.asSharedFlow()

  init {
    if (configuration != null) refreshDoors()
  }

  fun setPhone(value: String) {
    _uiState.update { it.copy(phone = value.filter(Char::isDigit).take(11)) }
  }

  fun setSecurityCode(value: String) {
    _uiState.update { it.copy(securityCode = value.filter(Char::isDigit).take(8)) }
  }

  fun sendSecurityCode() {
    val phone = uiState.value.phone
    if (!phone.matches(Regex("1\\d{10}"))) {
      showMessage("请输入 11 位手机号")
      return
    }
    launchRequest {
      api.sendSecurityCode(phone)
      showMessage("验证码已发送")
    }
  }

  fun login() {
    val phone = uiState.value.phone
    val code = uiState.value.securityCode
    if (!phone.matches(Regex("1\\d{10}")) || code.isBlank()) {
      showMessage("请输入手机号和短信验证码")
      return
    }
    launchRequest {
      val session = api.login(phone, code)
      configuration =
        SavedConfiguration(
          sessionId = session.sessionId,
          userId = session.userId,
          phone = phone,
          selectedKey = null,
        )
      store.save(requireNotNull(configuration))
      _uiState.update {
        it.copy(
          loggedIn = true,
          securityCode = "",
        )
      }
      loadDoors()
      showMessage("登录成功")
    }
  }

  fun refreshDoors() {
    if (configuration == null || uiState.value.busy) return
    launchRequest { loadDoors() }
  }

  fun openDoor(key: DoorKey) {
    val current = configuration ?: return
    if (uiState.value.busy) return
    viewModelScope.launch {
      _uiState.update {
        it.copy(busy = true, openingDoorId = key.stableId, successfulDoorId = null)
      }
      try {
        withContext(Dispatchers.IO) { api.openDoor(current.sessionId, key) }
        showMessage("开门成功")
        _uiState.update {
          it.copy(busy = false, openingDoorId = null, successfulDoorId = key.stableId)
        }
        delay(1_600)
        _uiState.update {
          if (it.successfulDoorId == key.stableId) it.copy(successfulDoorId = null) else it
        }
      } catch (error: Exception) {
        handleRequestError(error)
      } finally {
        _uiState.update {
          if (it.openingDoorId == key.stableId) {
            it.copy(busy = false, openingDoorId = null)
          } else {
            it
          }
        }
      }
    }
  }

  fun moveDoor(fromIndex: Int, toIndex: Int) {
    _uiState.update { state ->
      if (fromIndex !in state.doors.indices || toIndex !in state.doors.indices || fromIndex == toIndex) {
        state
      } else {
        val reordered = state.doors.toMutableList()
        reordered.add(toIndex, reordered.removeAt(fromIndex))
        state.copy(doors = reordered)
      }
    }
  }

  fun persistDoorOrder() {
    val doors = uiState.value.doors
    viewModelScope.launch(Dispatchers.IO) { store.saveDoorOrder(doors) }
  }

  fun logout() {
    configuration = null
    store.clear()
    _uiState.value = MainScreenUiState()
    DoorWidgetProvider.updateAll(getApplication())
    showMessage("已退出")
  }

  private fun loadDoors() {
    val current = configuration ?: return
    val doors = store.orderDoors(api.loadDoorKeys(current.sessionId))
    _uiState.update {
      it.copy(
        loggedIn = true,
        doors = doors,
      )
    }
    if (doors.isEmpty()) showMessage("没有可用钥匙")
    DoorWidgetProvider.updateAll(getApplication())
  }

  private fun launchRequest(block: suspend () -> Unit) {
    if (uiState.value.busy) return
    viewModelScope.launch {
      _uiState.update { it.copy(busy = true) }
      try {
        withContext(Dispatchers.IO) { block() }
      } catch (error: Exception) {
        handleRequestError(error)
      } finally {
        _uiState.update { it.copy(busy = false) }
      }
    }
  }

  private fun handleRequestError(error: Exception) {
    if (error is QinlinApiException && error.code == 401) {
      configuration = null
      store.clear()
      _uiState.update {
        it.copy(
          loggedIn = false,
          busy = false,
          doors = emptyList(),
          openingDoorId = null,
          successfulDoorId = null,
        )
      }
      DoorWidgetProvider.updateAll(getApplication())
    }
    showMessage(error.message?.takeIf(String::isNotBlank) ?: "请求失败")
  }

  private fun showMessage(message: String) {
    _messages.tryEmit(message)
  }
}
