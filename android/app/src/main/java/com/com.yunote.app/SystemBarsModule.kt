package com.yunote.app

import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SystemBarsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "SystemBars"

  @ReactMethod
  fun setNavigationBarStyle(color: String, darkIcons: Boolean) {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      val window = activity.window
      @Suppress("DEPRECATION")
      window.navigationBarColor = Color.parseColor(color)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        window.insetsController?.apply {
          hide(WindowInsets.Type.navigationBars())
          systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          setSystemBarsAppearance(
              if (darkIcons) WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS else 0,
              WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
          )
        }
      } else {
        @Suppress("DEPRECATION")
        var flags =
            window.decorView.systemUiVisibility or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          @Suppress("DEPRECATION")
          flags = if (darkIcons) {
            flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
          } else {
            flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
          }
        }
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = flags
      }
    }
  }
}

