#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const receiver = await readFile(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/LocationReminderReceiver.kt', import.meta.url), 'utf8');
const mainActivity = await readFile(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt', import.meta.url), 'utf8');
const manifest = await readFile(new URL('../src-tauri/gen/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const gradle = await readFile(new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../web/static/js/features/native-bridge.js', import.meta.url), 'utf8');
const desktop = await readFile(new URL('../web/static/js/features/desktop-integration.js', import.meta.url), 'utf8');

assert(receiver.includes('Geofence.GEOFENCE_TRANSITION_ENTER'), 'location reminders must support arrival geofences');
assert(receiver.includes('Geofence.GEOFENCE_TRANSITION_EXIT'), 'location reminders must support departure geofences');
assert(receiver.includes('LocationServices.getGeofencingClient'), 'location reminders must use Android geofencing locally');
assert(receiver.includes('Geocoder(context, Locale.getDefault())'), 'Android must resolve reminder addresses locally before geofencing');
assert(receiver.includes('optString("address")'), 'Android location schedules must consume address-only reminders');
assert(!receiver.includes('http://') && !receiver.includes('https://'), 'location trigger path must not call a server URL');
assert(receiver.includes('ACCESS_BACKGROUND_LOCATION'), 'permission state must account for background location');
assert(mainActivity.includes('scheduleLocationReminders'), 'Android bridge must expose location reminder scheduling');
assert(mainActivity.includes('requestLocationPermission'), 'Android bridge must expose a location permission request flow');
assert(receiver.includes('hasStoredLocationSchedules') && mainActivity.includes('!LocationReminderReceiver.hasStoredLocationSchedules(this)'), 'Android must not request location permission before at least one location schedule exists');
assert(mainActivity.includes('onRequestPermissionsResult'), 'Android must reschedule location reminders after permission results');
assert(mainActivity.includes('if (requestCode == 7303)') && mainActivity.includes('requestLocationPermission()'), 'Android must continue from fine-location grant into the background-location flow');
assert(mainActivity.includes('onResume()'), 'Android must reschedule location reminders after returning from settings');
assert(mainActivity.includes('ACTION_APPLICATION_DETAILS_SETTINGS'), 'Android 11+ background location must route through app settings');
assert(receiver.includes('addOnFailureListener'), 'Android geofence scheduling must observe async registration failures');
assert(receiver.includes('Looper.myLooper() == Looper.getMainLooper()'), 'Android geofence scheduling must avoid blocking the main thread');
assert(receiver.includes('DEFAULT_RADIUS_M = 150f'), 'Android geofencing must keep the radius fixed at 150m');
assert(mainActivity.includes('rescheduleStoredLocationReminders'), 'Android app startup must rehydrate stored location reminders');
assert(manifest.includes('android.permission.ACCESS_FINE_LOCATION'), 'Android manifest must request fine location');
assert(manifest.includes('android.permission.ACCESS_BACKGROUND_LOCATION'), 'Android manifest must request background location for geofencing');
assert(manifest.includes('.LocationReminderReceiver'), 'Android manifest must register location reminder receiver');
assert(gradle.includes('play-services-location'), 'Android build must include Play Services Location');
assert(bridge.includes('scheduleLocationReminders'), 'frontend native bridge must expose location reminder scheduling');
assert(desktop.includes('buildLocationReminderSchedules'), 'frontend native scheduling must include location reminders');

console.log('✅ Native Android location reminder tests passed');
