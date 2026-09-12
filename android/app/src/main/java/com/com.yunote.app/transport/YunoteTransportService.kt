package com.yunote.app.transport

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.yunote.app.R

class YunoteTransportService : HeadlessJsTaskService() {
  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "yuNote background actions", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("yuNote")
            .setContentText("Обрабатываем защищённый запрос")
            .setSilent(true)
            .setOngoing(true)
            .build()
    startForeground(NOTIFICATION_ID, notification)
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val transferId = intent?.getStringExtra("transferId") ?: return null
    val kind = intent.getStringExtra("kind") ?: return null
    val data = Arguments.createMap().apply {
      putString("transferId", transferId)
      putString("kind", kind)
      intent.getStringExtra("payloadJson")?.let { putString("payloadJson", it) }
    }
    return HeadlessJsTaskConfig("YunoteTransportTask", data, 60_000, true)
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL_ID = "yunote_local_transport"
    private const val NOTIFICATION_ID = 7301
  }
}

