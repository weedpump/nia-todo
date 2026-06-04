package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray

class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      ACTION_SHOW_REMINDER -> showReminder(context, intent)
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_USER_UNLOCKED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      "android.intent.action.QUICKBOOT_POWERON" -> {
        rescheduleStoredReminders(context)
        LocationReminderReceiver.rescheduleStoredLocationReminders(context)
      }
    }
  }

  private fun showReminder(context: Context, intent: Intent) {
    if (!hasNotificationPermission(context)) return
    createNotificationChannel(context)

    val title = intent.getStringExtra(EXTRA_TITLE) ?: "⏰ Erinnerung"
    val body = intent.getStringExtra(EXTRA_BODY) ?: "Todo-Erinnerung"
    val id = intent.getStringExtra(EXTRA_ID) ?: System.currentTimeMillis().toString()

    val openIntent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val doneIntent = Intent(context, MainActivity::class.java).apply {
      action = ACTION_MARK_DONE
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra(EXTRA_ID, id)
      putExtra(EXTRA_USER_ID, intent.getStringExtra(EXTRA_USER_ID) ?: "")
    }
    val contentIntent = PendingIntent.getActivity(
      context,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val donePendingIntent = PendingIntent.getActivity(
      context,
      notificationId("done-$id"),
      doneIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val largeIcon = BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher)
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_notification)
      .setLargeIcon(largeIcon)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setAutoCancel(true)
      .setContentIntent(contentIntent)
      .addAction(R.drawable.ic_stat_notification, "Erledigt", donePendingIntent)
      .build()

    NotificationManagerCompat.from(context).notify(notificationId(id), notification)
  }

  companion object {
    const val ACTION_SHOW_REMINDER = "de.tobiaskneidl.nia_todo.SHOW_REMINDER"
    const val ACTION_MARK_DONE = "de.tobiaskneidl.nia_todo.MARK_DONE"
    const val EXTRA_ID = "id"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_DUE_AT_MS = "dueAtMs"
    const val EXTRA_USER_ID = "userId"
    const val PREFS_NAME = "nia_todo_reminders"
    const val PREFS_SCHEDULES = "schedules"
    const val PREFS_PENDING_DONE_ID = "pendingDoneId_v2"
    const val PREFS_PENDING_DONE_ACTION = "pendingDoneAction_v1"
    const val CHANNEL_ID = "nia_todo_reminders"

    fun createNotificationChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val channel = NotificationChannel(
        CHANNEL_ID,
        "nia-todo Erinnerungen",
        NotificationManager.IMPORTANCE_DEFAULT,
      ).apply {
        description = "Native Benachrichtigungen für Todo-Erinnerungen"
      }
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun hasNotificationPermission(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
      return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    fun scheduleReminders(context: Context, schedulesJson: String): Int {
      createNotificationChannel(context)
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      cancelReminders(context, prefs.getString(PREFS_SCHEDULES, "[]") ?: "[]")
      prefs.edit().putString(PREFS_SCHEDULES, schedulesJson).apply()
      return scheduleRemindersFromJson(context, schedulesJson)
    }

    fun rescheduleStoredReminders(context: Context): Int {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      return scheduleRemindersFromJson(context, prefs.getString(PREFS_SCHEDULES, "[]") ?: "[]")
    }

    private fun scheduleRemindersFromJson(context: Context, schedulesJson: String): Int {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val schedules = JSONArray(schedulesJson)
      val now = System.currentTimeMillis()
      var scheduled = 0

      for (index in 0 until schedules.length()) {
        val schedule = schedules.optJSONObject(index) ?: continue
        val id = schedule.optString("id")
        val dueAtMs = schedule.optLong("dueAtMs", 0L)
        if (id.isBlank() || dueAtMs <= now) continue

        val pendingIntent = reminderPendingIntent(
          context = context,
          id = id,
          title = schedule.optString("title", "⏰ Erinnerung"),
          body = schedule.optString("body", "Todo-Erinnerung"),
          dueAtMs = dueAtMs,
          userId = schedule.optString("userId", ""),
          flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ) ?: continue

        scheduleReminderAlarm(alarmManager, dueAtMs, pendingIntent)
        scheduled += 1
      }

      return scheduled
    }

    private fun scheduleReminderAlarm(alarmManager: AlarmManager, dueAtMs: Long, pendingIntent: PendingIntent) {
      try {
        if (canScheduleExactAlarms(alarmManager)) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAtMs, pendingIntent)
          } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            alarmManager.setExact(AlarmManager.RTC_WAKEUP, dueAtMs, pendingIntent)
          } else {
            alarmManager.set(AlarmManager.RTC_WAKEUP, dueAtMs, pendingIntent)
          }
          return
        }
      } catch (_: SecurityException) {
        // Exact alarms can be revoked by Android/OEM policy; fall back below.
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAtMs, pendingIntent)
      } else {
        alarmManager.set(AlarmManager.RTC_WAKEUP, dueAtMs, pendingIntent)
      }
    }

    private fun canScheduleExactAlarms(alarmManager: AlarmManager): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
      return try {
        alarmManager.canScheduleExactAlarms()
      } catch (_: Exception) {
        false
      }
    }

    private fun cancelReminders(context: Context, schedulesJson: String) {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val schedules = JSONArray(schedulesJson)
      for (index in 0 until schedules.length()) {
        val id = schedules.optJSONObject(index)?.optString("id") ?: continue
        if (id.isBlank()) continue
        val pendingIntent = reminderPendingIntent(
          context = context,
          id = id,
          title = "",
          body = "",
          dueAtMs = 0L,
          userId = "",
          flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) ?: continue
        alarmManager.cancel(pendingIntent)
        pendingIntent.cancel()
      }
    }

    private fun reminderPendingIntent(
      context: Context,
      id: String,
      title: String,
      body: String,
      dueAtMs: Long,
      userId: String,
      flags: Int,
    ): PendingIntent? {
      val intent = Intent(context, ReminderReceiver::class.java).apply {
        action = ACTION_SHOW_REMINDER
        putExtra(EXTRA_ID, id)
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_BODY, body)
        putExtra(EXTRA_DUE_AT_MS, dueAtMs)
        putExtra(EXTRA_USER_ID, userId)
      }
      return PendingIntent.getBroadcast(context, notificationId(id), intent, flags)
    }

    private fun notificationId(id: String): Int {
      return id.hashCode().let { if (it == Int.MIN_VALUE) 0 else kotlin.math.abs(it) }
    }
  }
}
