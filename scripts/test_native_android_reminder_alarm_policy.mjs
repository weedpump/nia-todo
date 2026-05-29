#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const manifest = await readFile(new URL('../src-tauri/gen/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const receiver = await readFile(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/ReminderReceiver.kt', import.meta.url), 'utf8');
const mainActivity = await readFile(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.includes('android.permission.SCHEDULE_EXACT_ALARM'), 'Android reminders need SCHEDULE_EXACT_ALARM permission for reliable exact scheduling');
for (const action of [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.LOCKED_BOOT_COMPLETED',
  'android.intent.action.MY_PACKAGE_REPLACED',
  'android.intent.action.QUICKBOOT_POWERON',
]) {
  assert(manifest.includes(action), `Reminder receiver must reschedule stored reminders after ${action}`);
}
assert(receiver.includes('setExactAndAllowWhileIdle'), 'ReminderReceiver must prefer exact while-idle alarms when Android allows them');
assert(receiver.includes('canScheduleExactAlarms'), 'ReminderReceiver must check exact-alarm capability on Android 12+');
assert(receiver.includes('setAndAllowWhileIdle'), 'ReminderReceiver must keep a while-idle fallback when exact alarms are not available');
assert(mainActivity.includes('ReminderReceiver.rescheduleStoredReminders(this)'), 'MainActivity should rehydrate stored reminders whenever the native app starts');

console.log('✅ Android reminder alarm policy test passed');
