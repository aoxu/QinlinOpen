package top.rpone.qinlinopen.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

data class SavedConfiguration(
  val sessionId: String,
  val userId: String?,
  val phone: String,
  val selectedKey: DoorKey?,
)

class SecureStore(context: Context) {
  private val preferences =
    context.getSharedPreferences("qinlin_open_secure", Context.MODE_PRIVATE)

  fun load(): SavedConfiguration? {
    val encrypted = preferences.getString(PREF_CREDENTIALS, null) ?: return null
    return runCatching {
        val root = JSONObject(decrypt(encrypted))
        SavedConfiguration(
          sessionId = root.getString("sessionId"),
          userId = root.optString("userId").takeIf(String::isNotBlank),
          phone = root.optString("phone"),
          selectedKey = root.optJSONObject("selectedKey")?.toDoorKey(),
        )
      }
      .getOrNull()
  }

  fun save(configuration: SavedConfiguration) {
    val root =
      JSONObject()
        .put("sessionId", configuration.sessionId)
        .put("userId", configuration.userId.orEmpty())
        .put("phone", configuration.phone)
    configuration.selectedKey?.let { key ->
      root.put("selectedKey", key.toJson())
    }
    preferences.edit().putString(PREF_CREDENTIALS, encrypt(root.toString())).apply()
  }

  fun loadWidgetKey(appWidgetId: Int): DoorKey? {
    val encrypted = preferences.getString(widgetPreference(appWidgetId), null) ?: return null
    return runCatching { JSONObject(decrypt(encrypted)).toDoorKey() }.getOrNull()
  }

  fun saveWidgetKey(appWidgetId: Int, key: DoorKey) {
    preferences
      .edit()
      .putString(widgetPreference(appWidgetId), encrypt(key.toJson().toString()))
      .apply()
  }

  fun orderDoors(doors: List<DoorKey>): List<DoorKey> {
    val positions = loadDoorOrder().withIndex().associate { (index, id) -> id to index }
    return doors
      .withIndex()
      .sortedWith(
        compareBy<IndexedValue<DoorKey>> { positions[it.value.stableId] ?: Int.MAX_VALUE }
          .thenBy(IndexedValue<DoorKey>::index)
      )
      .map(IndexedValue<DoorKey>::value)
  }

  fun saveDoorOrder(doors: List<DoorKey>) {
    val order = JSONArray()
    doors.forEach { order.put(it.stableId) }
    preferences.edit().putString(PREF_DOOR_ORDER, encrypt(order.toString())).apply()
  }

  fun deleteWidgetKeys(appWidgetIds: IntArray) {
    preferences.edit().also { editor ->
      appWidgetIds.forEach { editor.remove(widgetPreference(it)) }
    }.apply()
  }

  fun clearLegacySelection() {
    val configuration = load() ?: return
    if (configuration.selectedKey != null) save(configuration.copy(selectedKey = null))
  }

  fun clear() {
    preferences.edit().clear().apply()
  }

  private fun widgetPreference(appWidgetId: Int) = "$PREF_WIDGET_PREFIX$appWidgetId"

  private fun loadDoorOrder(): List<String> {
    val encrypted = preferences.getString(PREF_DOOR_ORDER, null) ?: return emptyList()
    return runCatching {
        val order = JSONArray(decrypt(encrypted))
        List(order.length()) { index -> order.getString(index) }
      }
      .getOrDefault(emptyList())
  }

  private fun DoorKey.toJson() =
    JSONObject()
      .put("communityId", communityId)
      .put("communityName", communityName)
      .put("doorControlId", doorControlId)
      .put("doorName", doorName)

  private fun JSONObject.toDoorKey() =
    DoorKey(
      communityId = getString("communityId"),
      communityName = optString("communityName"),
      doorControlId = getString("doorControlId"),
      doorName = getString("doorName"),
    )

  private fun encrypt(plainText: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
    val payload =
      JSONObject()
        .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        .put(
          "ciphertext",
          Base64.encodeToString(
            cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8)),
            Base64.NO_WRAP,
          ),
        )
    return payload.toString()
  }

  private fun decrypt(payload: String): String {
    val root = JSONObject(payload)
    val iv = Base64.decode(root.getString("iv"), Base64.NO_WRAP)
    val ciphertext = Base64.decode(root.getString("ciphertext"), Base64.NO_WRAP)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
    return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
  }

  private fun getOrCreateKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build()
    )
    return generator.generateKey()
  }

  companion object {
    private const val PREF_CREDENTIALS = "credentials"
    private const val PREF_DOOR_ORDER = "door_order"
    private const val PREF_WIDGET_PREFIX = "widget_key_"
    private const val KEY_ALIAS = "qinlin_open_credentials_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}
