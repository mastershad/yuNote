package com.yunote.app.transport

import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class YunoteTransportService : HeadlessJsTaskService() {
  private val messenger = Messenger(IncomingHandler())

  override fun onBind(intent: Intent): IBinder = messenger.binder

  private inner class IncomingHandler : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      if (message.what != MESSAGE_DELIVER) {
        super.handleMessage(message)
        return
      }
      val transferId = message.data.getString("transferId") ?: return
      val kind = message.data.getString("kind") ?: return
      startTask(taskConfig(transferId, kind, message.data.getString("payloadJson")))
    }
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val transferId = intent?.getStringExtra("transferId") ?: return null
    val kind = intent.getStringExtra("kind") ?: return null
    return taskConfig(transferId, kind, intent.getStringExtra("payloadJson"))
  }

  private fun taskConfig(transferId: String, kind: String, payloadJson: String?): HeadlessJsTaskConfig {
    val data = Arguments.createMap().apply {
      putString("transferId", transferId)
      putString("kind", kind)
      payloadJson?.let { putString("payloadJson", it) }
    }
    return HeadlessJsTaskConfig("YunoteTransportTask", data, 60_000, true)
  }

  companion object {
    const val MESSAGE_DELIVER = 1
  }
}
