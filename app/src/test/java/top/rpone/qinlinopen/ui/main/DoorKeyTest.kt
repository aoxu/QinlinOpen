package top.rpone.qinlinopen.ui.main

import top.rpone.qinlinopen.data.DoorKey
import org.junit.Assert.assertEquals
import org.junit.Test

class DoorKeyTest {
  @Test
  fun displayNameIncludesCommunityWhenPresent() {
    val key = DoorKey("1", "示例小区", "2", "公寓大门")
    assertEquals("示例小区 公寓大门", key.displayName)
  }
}
