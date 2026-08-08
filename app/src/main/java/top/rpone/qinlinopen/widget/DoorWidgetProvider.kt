package top.rpone.qinlinopen.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.RemoteViews
import android.widget.Toast
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import top.rpone.qinlinopen.R
import top.rpone.qinlinopen.data.QinlinApi
import top.rpone.qinlinopen.data.SecureStore

private enum class WidgetVisual(val iconRes: Int?) {
  Normal(R.drawable.ic_lock_open),
  Loading(null),
  Success(R.drawable.ic_check_circle),
}

class DoorWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    migrateLegacyBindings(context, appWidgetIds)
    appWidgetIds.forEach { appWidgetId ->
      appWidgetManager.updateAppWidget(appWidgetId, views(context, appWidgetId))
    }
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    appWidgetManager.updateAppWidget(appWidgetId, views(context, appWidgetId))
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    SecureStore(context).deleteWidgetKeys(appWidgetIds)
    appWidgetIds.forEach(openingWidgetIds::remove)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action != ACTION_OPEN) return

    val appWidgetId =
      intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID || !openingWidgetIds.add(appWidgetId)) {
      return
    }

    val pendingResult = goAsync()
    updateWidget(context, appWidgetId, WidgetVisual.Loading)
    val executor = Executors.newSingleThreadExecutor()
    executor.execute {
      val result =
        runCatching {
          val store = SecureStore(context)
          val configuration = store.load() ?: error("请先登录")
          val key = store.loadWidgetKey(appWidgetId) ?: error("请选择钥匙")
          QinlinApi(context).openDoor(configuration.sessionId, key)
        }
      Handler(Looper.getMainLooper()).post {
        if (result.isSuccess) {
          Toast.makeText(context, "开门成功", Toast.LENGTH_SHORT).show()
          showSuccess(context, appWidgetId) {
            openingWidgetIds.remove(appWidgetId)
            pendingResult.finish()
            executor.shutdown()
          }
        } else {
          Toast.makeText(
              context,
              result.exceptionOrNull()?.message ?: "开门失败",
              Toast.LENGTH_SHORT,
            )
            .show()
          updateWidget(context, appWidgetId)
          openingWidgetIds.remove(appWidgetId)
          pendingResult.finish()
          executor.shutdown()
        }
      }
    }
  }

  companion object {
    private const val ACTION_OPEN = "top.rpone.qinlinopen.action.OPEN_DOOR"
    private val openingWidgetIds = ConcurrentHashMap.newKeySet<Int>()

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, DoorWidgetProvider::class.java)
      val appWidgetIds = manager.getAppWidgetIds(component)
      migrateLegacyBindings(context, appWidgetIds)
      appWidgetIds.forEach { appWidgetId -> updateWidget(context, appWidgetId) }
    }

    fun update(context: Context, appWidgetId: Int) {
      updateWidget(context, appWidgetId)
    }

    private fun migrateLegacyBindings(context: Context, appWidgetIds: IntArray) {
      if (appWidgetIds.isEmpty()) return
      val store = SecureStore(context)
      val legacyKey = store.load()?.selectedKey ?: return
      appWidgetIds.forEach { appWidgetId ->
        if (store.loadWidgetKey(appWidgetId) == null) store.saveWidgetKey(appWidgetId, legacyKey)
      }
      store.clearLegacySelection()
    }

    private fun showSuccess(context: Context, appWidgetId: Int, onFinished: () -> Unit) {
      val handler = Handler(Looper.getMainLooper())
      updateWidget(context, appWidgetId, WidgetVisual.Success)
      handler.postDelayed(
        {
          updateWidget(context, appWidgetId)
          onFinished()
        },
        1_600,
      )
    }

    private fun updateWidget(
      context: Context,
      appWidgetId: Int,
      visual: WidgetVisual = WidgetVisual.Normal,
    ) {
      AppWidgetManager.getInstance(context)
        .updateAppWidget(appWidgetId, views(context, appWidgetId, visual))
    }

    private fun views(
      context: Context,
      appWidgetId: Int,
      visual: WidgetVisual = WidgetVisual.Normal,
    ): RemoteViews {
      val store = SecureStore(context)
      val configuration = store.load()
      val selected = store.loadWidgetKey(appWidgetId)
      val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId)
      val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 130)
      val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 130)
      val layout =
        when {
          width < 110 && height < 110 -> R.layout.widget_door_compact
          height < 110 || width >= 190 -> R.layout.widget_door_wide
          else -> R.layout.widget_door
        }
      val views = RemoteViews(context.packageName, layout)

      views.setViewVisibility(
        R.id.widget_loading,
        if (visual == WidgetVisual.Loading) View.VISIBLE else View.GONE,
      )
      views.setViewVisibility(
        R.id.widget_status_icon,
        if (visual == WidgetVisual.Loading) View.GONE else View.VISIBLE,
      )
      visual.iconRes?.let { views.setImageViewResource(R.id.widget_status_icon, it) }
      views.setTextViewText(
        R.id.widget_door_name,
        selected?.doorName ?: if (configuration == null) "请先登录" else "选择钥匙",
      )
      views.setTextViewText(R.id.widget_community_name, selected?.communityName.orEmpty())
      views.setViewVisibility(
        R.id.widget_community_name,
        if (layout == R.layout.widget_door_compact || selected?.communityName.isNullOrBlank()) {
          View.GONE
        } else {
          View.VISIBLE
        },
      )

      val clickIntent =
        if (selected == null) {
          PendingIntent.getActivity(
            context,
            appWidgetId,
            Intent(context, DoorWidgetConfigureActivity::class.java)
              .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
              .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          )
        } else {
          PendingIntent.getBroadcast(
            context,
            appWidgetId,
            Intent(context, DoorWidgetProvider::class.java)
              .setPackage(context.packageName)
              .setAction(ACTION_OPEN)
              .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          )
        }
      views.setOnClickPendingIntent(R.id.widget_open_button, clickIntent)
      return views
    }
  }
}
