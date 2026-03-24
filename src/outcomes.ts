export function inferOutcome(payload: Record<string, unknown>): string {
  const blob = JSON.stringify(payload).toLowerCase();
  const has = (text: string) => blob.includes(text);
  const hasAny = (values: string[]) => values.some((value) => has(value));

  if (has("voicemail")) {
    return "voicemail";
  }

  if (has("not interested") || has("no interest")) {
    return "not_interested";
  }

  if (has("call back") || has("callback")) {
    return "callback_requested";
  }

  if (has("no answer")) {
    return "no_answer";
  }

  if (has("no contact")) {
    return "no_answer";
  }

  const hasNegativeBookedSignal = hasAny([
    "not booked",
    "\"booked\":false",
    "\"booked\": false",
    "booking failed",
    "unable to book",
    "did not book"
  ]);

  const hasPositiveBookedSignal = hasAny([
    "meeting booked",
    "appointment booked",
    "calendar invite sent",
    "booked a meeting",
    "booked the meeting",
    "\"outcome\":\"booked\"",
    "\"outcome\": \"booked\"",
    "\"status\":\"booked\"",
    "\"status\": \"booked\""
  ]);

  if (hasPositiveBookedSignal && !hasNegativeBookedSignal) {
    return "booked";
  }

  const hangupSignals = [
    "hangup",
    "hung up",
    "ended by customer",
    "customer ended call",
    "caller ended call",
    "user ended call",
    "call ended by user",
    "customer-disconnected"
  ];

  if (hangupSignals.some((signal) => blob.includes(signal))) {
    return "answered_hung_up";
  }

  return "completed";
}

export function hasPromptInjectionSignals(payload: Record<string, unknown>): boolean {
  const blob = JSON.stringify(payload).toLowerCase();
  const signals = [
    "ignore previous instructions",
    "reveal your prompt",
    "system prompt",
    "jailbreak",
    "act as"
  ];

  return signals.some((signal) => blob.includes(signal));
}
