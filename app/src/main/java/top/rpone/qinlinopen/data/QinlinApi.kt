package top.rpone.qinlinopen.data

import android.content.Context
import android.provider.Settings
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

data class DoorKey(
  val communityId: String,
  val communityName: String,
  val doorControlId: String,
  val doorName: String,
) {
  val stableId: String
    get() = "$communityId:$doorControlId"

  val displayName: String
    get() = if (communityName.isBlank()) doorName else "$communityName $doorName"
}

data class LoginSession(val sessionId: String, val userId: String?)

class QinlinApi(private val context: Context) {
  private val random = SecureRandom()

  fun sendSecurityCode(phone: String) {
    val timestamp = System.currentTimeMillis()
    val nonce = nonce(4)
    val sign =
      md5(
        "appid=$SMS_APP_ID&mobile=$phone&nonce=$nonce&timestamp=$timestamp" +
          "&version=v2&appsecret=$SMS_APP_SECRET"
      )
    val response =
      postJson(
        url = SMS_URL,
        json = JSONObject().put("mobile", phone),
        extraHeaders =
          mapOf(
            "appid" to SMS_APP_ID,
            "version" to "v2",
            "timestamp" to timestamp.toString(),
            "nonce" to nonce,
            "sign" to sign,
          ),
      )
    requireSuccess(response)
  }

  fun login(phone: String, securityCode: String): LoginSession {
    val response =
      signedJsonPost(
        endpoint = "app/v1/login",
        sessionId = "",
        fields =
          linkedMapOf(
            "mobile" to encryptPhone(phone),
            "smsCode" to securityCode,
            "appChannel" to APP_CHANNEL,
          ),
      )
    val data = requireSuccess(response)
    val sessionId = findString(data, listOf("sessionId", "sessionID", "token"))
      ?: error("登录成功，但响应中没有 sessionId")
    val userId = findString(data, listOf("userId", "uid"))
    return LoginSession(sessionId = sessionId, userId = userId)
  }

  fun loadDoorKeys(sessionId: String): List<DoorKey> {
    val communityResponse =
      signedJsonPost(
        endpoint = "app/user/v2/communityInfo",
        sessionId = sessionId,
        fields = linkedMapOf("method" to "communityInfo"),
      )
    val communityData = requireSuccess(communityResponse)
    val communities =
      objectsContaining(communityData, "communityId")
        .mapNotNull { item ->
          val id = item.valueAsString("communityId") ?: return@mapNotNull null
          val name =
            item.firstString("communityName", "name", "communityShortName", "projectName")
              .orEmpty()
          id to name
        }
        .distinctBy { it.first }

    return communities
      .flatMap { (communityId, communityName) ->
        val response =
          signedMultipartPost(
            endpoint = "app/user/v2/queryUserDoorByCacheNew",
            sessionId = sessionId,
            fields = linkedMapOf("communityId" to numericOrString(communityId)),
          )
        val data = requireSuccess(response)
        objectsContaining(data, "doorControlId").mapNotNull { item ->
          val doorId = item.valueAsString("doorControlId") ?: return@mapNotNull null
          val doorName =
            item.firstString(
              "doorControlName",
              "doorName",
              "name",
              "deviceName",
              "remarkName",
            ) ?: "钥匙 $doorId"
          DoorKey(
            communityId = communityId,
            communityName =
              item.firstString("communityName", "projectName") ?: communityName,
            doorControlId = doorId,
            doorName = doorName,
          )
        }
      }
      .distinctBy { "${it.communityId}:${it.doorControlId}" }
      .sortedWith(compareBy(DoorKey::communityName, DoorKey::doorName))
  }

  fun openDoor(sessionId: String, key: DoorKey): String {
    val fields =
      linkedMapOf<String, Any>(
        "appChannel" to APP_CHANNEL,
        "doorControlId" to numericOrString(key.doorControlId),
        "communityId" to numericOrString(key.communityId),
      )
    val signedFields = signFields(fields, sessionId)
    val query = linkedMapOf<String, Any>("sessionId" to sessionId).apply { putAll(signedFields) }
    val response =
      request(
        url = "$BASE_URL/open/doorcontrol/v2/open?${encodeQuery(query)}",
        contentType = "application/json; charset=utf-8",
        body = ByteArray(0),
      )
    requireSuccess(response)
    return response.optString("message").ifBlank { "开门请求已发送" }
  }

  private fun signedJsonPost(
    endpoint: String,
    sessionId: String,
    fields: LinkedHashMap<String, Any>,
  ): JSONObject {
    val signedFields = signFields(fields, sessionId)
    return request(
      url = "$BASE_URL/$endpoint?${encodeQuery(mapOf("sessionId" to sessionId))}",
      contentType = "application/json; charset=utf-8",
      body = JSONObject(signedFields as Map<*, *>).toString().toByteArray(StandardCharsets.UTF_8),
    )
  }

  private fun signedMultipartPost(
    endpoint: String,
    sessionId: String,
    fields: LinkedHashMap<String, Any>,
  ): JSONObject {
    val signedFields = signFields(fields, sessionId)
    val boundary = "qinlin-open-${nonce(12)}"
    val output = ByteArrayOutputStream()
    signedFields.forEach { (name, value) ->
      output.write("--$boundary\r\n".toByteArray())
      output.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
      output.write(value.toString().toByteArray(StandardCharsets.UTF_8))
      output.write("\r\n".toByteArray())
    }
    output.write("--$boundary--\r\n".toByteArray())
    return request(
      url = "$BASE_URL/$endpoint?${encodeQuery(mapOf("sessionId" to sessionId))}",
      contentType = "multipart/form-data; boundary=$boundary",
      body = output.toByteArray(),
    )
  }

  private fun signFields(
    fields: LinkedHashMap<String, Any>,
    sessionId: String,
  ): LinkedHashMap<String, Any> {
    val timestamp = System.currentTimeMillis()
    val nonce = nonce(5)
    val signValues =
      linkedMapOf<String, Any>().apply {
        putAll(fields)
        put("nonce", nonce)
        put("timestamp", timestamp)
        put("token", sessionId)
        put("version", APP_VERSION)
      }
    val sign = md5("${encodeQuery(signValues)}&key=$SIGNING_SALT")
    return linkedMapOf<String, Any>().apply {
      putAll(fields)
      put("timestamp", timestamp)
      put("version", APP_VERSION)
      put("nonce", nonce)
      put("sign", sign)
    }
  }

  private fun postJson(
    url: String,
    json: JSONObject,
    extraHeaders: Map<String, String> = emptyMap(),
  ): JSONObject =
    request(
      url = url,
      contentType = "application/json; charset=utf-8",
      body = json.toString().toByteArray(StandardCharsets.UTF_8),
      extraHeaders = extraHeaders,
    )

  private fun request(
    url: String,
    contentType: String,
    body: ByteArray,
    extraHeaders: Map<String, String> = emptyMap(),
  ): JSONObject {
    val connection = URI(url).toURL().openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "POST"
      connection.connectTimeout = TIMEOUT_MILLIS
      connection.readTimeout = TIMEOUT_MILLIS
      connection.instanceFollowRedirects = true
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", contentType)
      commonHeaders().forEach(connection::setRequestProperty)
      extraHeaders.forEach(connection::setRequestProperty)
      connection.outputStream.use { it.write(body) }

      val status = connection.responseCode
      val input = if (status >= 400) connection.errorStream else connection.inputStream
      val text = input?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
      if (text.isBlank()) error("服务器返回空响应（HTTP $status）")
      return JSONObject(text)
    } finally {
      connection.disconnect()
    }
  }

  private fun commonHeaders(): Map<String, String> =
    mapOf(
      "openid" to
        (Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
          ?: "0000000000000000"),
      "User-Agent" to "Dart/3.8 (dart:io)",
      "qversioncode" to APP_VERSION_CODE,
      "qchannel" to "google",
      "qplatform" to "0",
      "qvendor" to android.os.Build.MANUFACTURER.lowercase(Locale.US),
    )

  private fun requireSuccess(response: JSONObject): Any {
    val success = response.optBoolean("success", false)
    val code = response.optInt("code", Int.MIN_VALUE)
    if (!success && code != 0 && code !in 200..299) {
      throw QinlinApiException(
        response.optString("message").ifBlank { "请求失败（code=$code）" },
        code,
      )
    }
    return normalizeJson(response.opt("data"))
  }

  private fun normalizeJson(value: Any?): Any {
    if (value is String) {
      val text = value.trim()
      if (text.startsWith("{") && text.endsWith("}")) return JSONObject(text)
      if (text.startsWith("[") && text.endsWith("]")) return JSONArray(text)
    }
    return value ?: JSONObject.NULL
  }

  private fun objectsContaining(root: Any, key: String): List<JSONObject> {
    val matches = mutableListOf<JSONObject>()
    fun visit(value: Any?) {
      when (val normalized = normalizeJson(value)) {
        is JSONObject -> {
          if (normalized.has(key) && !normalized.isNull(key)) matches += normalized
          val keys = normalized.keys()
          while (keys.hasNext()) visit(normalized.opt(keys.next()))
        }
        is JSONArray -> for (index in 0 until normalized.length()) visit(normalized.opt(index))
      }
    }
    visit(root)
    return matches
  }

  private fun findString(root: Any, candidateKeys: List<String>): String? {
    var result: String? = null
    fun visit(value: Any?) {
      if (result != null) return
      when (val normalized = normalizeJson(value)) {
        is JSONObject -> {
          candidateKeys.firstNotNullOfOrNull { normalized.valueAsString(it) }?.let {
            result = it
            return
          }
          val keys = normalized.keys()
          while (keys.hasNext()) visit(normalized.opt(keys.next()))
        }
        is JSONArray -> for (index in 0 until normalized.length()) visit(normalized.opt(index))
      }
    }
    visit(root)
    return result
  }

  private fun JSONObject.valueAsString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return opt(key)?.toString()?.takeIf { it.isNotBlank() && it != "null" }
  }

  private fun JSONObject.firstString(vararg keys: String): String? =
    keys.firstNotNullOfOrNull { key -> valueAsString(key) }

  private fun encodeQuery(values: Map<String, Any>): String =
    values.entries
      .sortedBy { it.key }
      .joinToString("&") { (key, value) -> "${encode(key)}=${encode(value.toString())}" }

  private fun encode(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("%3A", ":")

  private fun encryptPhone(phone: String): String {
    val key = HEX_AES_KEY.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
    return cipher.doFinal(phone.toByteArray(StandardCharsets.UTF_8)).toHex()
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02X".format(it) }

  private fun md5(value: String): String =
    MessageDigest.getInstance("MD5")
      .digest(value.toByteArray(StandardCharsets.UTF_8))
      .toHex()
      .uppercase(Locale.US)

  private fun nonce(length: Int): String =
    buildString(length) { repeat(length) { append(random.nextInt(10)) } }

  private fun numericOrString(value: String): Any = value.toLongOrNull() ?: value

  companion object {
    private const val BASE_URL = "https://mobileapi3.qinlinkeji.com/api"
    private const val SMS_URL = "https://gateway2.qinlinkeji.com/member/sms/sendSecurityCode"
    private const val APP_VERSION = "5.2.6"
    private const val APP_VERSION_CODE = "3146"
    private const val APP_CHANNEL = 1
    private const val SIGNING_SALT = "qiAnlPinP"
    private const val HEX_AES_KEY = "FBC213C4C7BEEBD2AA4EDBF0F681C41B"
    private const val SMS_APP_ID = "gbDjIZQSOpCMX49P"
    private const val SMS_APP_SECRET = "OKFoQ9MmNXQtcyXROo4PnaFkfDPTHuDg"
    private const val TIMEOUT_MILLIS = 8_000
  }
}

class QinlinApiException(message: String, val code: Int) : Exception(message)
