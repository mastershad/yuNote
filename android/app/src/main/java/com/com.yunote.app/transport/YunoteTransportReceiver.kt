package com.yunote.app.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService

class YunoteTransportReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_TRANSPORT) return
    if (intent.getStringExtra("transferId").isNullOrBlank()) return
    if (intent.getStringExtra("kind").isNullOrBlank()) return

    val serviceIntent = Intent(context, YunoteTransportService::class.java).apply {
      putExtras(intent)
    }
    HeadlessJsTaskService.acquireWakeLockNow(context)
    ContextCompat.startForegroundService(context, serviceIntent)
  }

  companion object {
    const val ACTION_TRANSPORT = "com.yunote.LOCAL_TRANSPORT"
  }
}

