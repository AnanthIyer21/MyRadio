// Context agent: turn raw signals into a usable listening-mode label.
// Wearable signals (Apple Watch via HealthKit in the native app; simulated on web)
// take priority — your body says more about the moment than the clock does.

export function detectContext({ localHour = 9, dayOfWeek = 1, activity, device, wearable } = {}) {
  const weekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const hr = wearable?.heartRate;
  const motion = wearable?.motion;

  let mode = "idle";
  let source = "time"; // what decided the mode (useful for the UI / debugging)

  // 1) Wearable wins when present.
  if (motion === "workout" || motion === "running" || (hr && hr >= 110)) { mode = "workout"; source = "wearable"; }
  else if (motion === "walking") { mode = "walking"; source = "wearable"; }
  else if (hr && hr < 60 && (localHour >= 20 || localHour < 7)) { mode = "evening_wind_down"; source = "wearable"; }
  // 2) Explicit activity from onboarding.
  else if (activity === "workout") { mode = "workout"; source = "activity"; }
  else if (activity === "walking") { mode = "walking"; source = "activity"; }
  else if (activity === "focus") { mode = "focus_block"; source = "activity"; }
  // 3) Time of day.
  else if (weekday && localHour >= 6 && localHour <= 9) mode = "morning_commute";
  else if (weekday && localHour >= 16 && localHour <= 19) mode = "evening_commute";
  else if (localHour >= 20 || localHour < 6) mode = "evening_wind_down";

  return {
    mode,
    source,
    timeOfDay: localHour < 12 ? "morning" : localHour < 18 ? "afternoon" : "evening",
    weekday,
    heartRate: hr ?? null,
    device: device || "unknown",
  };
}
