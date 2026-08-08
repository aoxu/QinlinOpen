package top.rpone.qinlinopen.ui.main

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import top.rpone.qinlinopen.data.DoorKey
import org.junit.Rule
import org.junit.Test

class MainScreenTest {
  @get:Rule val composeTestRule = createAndroidComposeRule<ComponentActivity>()

  @Test
  fun tappingAKeyCardOpensThatDoorDirectly() {
    val key = DoorKey("1", "示例小区", "2", "示例门")
    var openedKey: DoorKey? = null
    composeTestRule.setContent {
      MainScreen(
        state = MainScreenUiState(loggedIn = true, doors = listOf(key)),
        onPhoneChange = {},
        onCodeChange = {},
        onSendCode = {},
        onLogin = {},
        onRefresh = {},
        onOpenDoor = { openedKey = it },
        onMoveDoor = { _, _ -> },
        onDoorOrderChanged = {},
        onLogout = {},
      )
    }

    composeTestRule.onNodeWithText("示例门").assertExists().performClick()
    composeTestRule.onNodeWithText("示例小区").assertExists()
    composeTestRule.onNodeWithText("请先选择钥匙").assertDoesNotExist()
    composeTestRule.runOnIdle { assert(openedKey == key) }
  }
}
