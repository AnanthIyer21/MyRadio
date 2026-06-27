// Context agent: turn raw signals into a usable listening-mode label.

export function detectContext({ localHour = 9, dayOfWeek = 1, activity, device } = {}) {
  const weekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  let mode = "idle";
  if (activity === "workout") mode = "workout";
  else if (activity === "walking") mode = "walking";
  else if (activity === "focus") mode = "focus_block";
  else if (weekday && localHour >= 6 && localHour <= 9) mode = "morning_commute";
  else if (weekday && localHour >= 16 && localHour <= 19) mode = "evening_commute";
  else if (localHour >= 20 || localHour < 6) mode = "evening_wind_down";

  return {
    mode,
    timeOfDay: localHour < 12 ? "morning" : localHour < 18 ? "afternoon" : "evening",
    weekday,
    device: device || "unknown",
  };
}
