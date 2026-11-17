# External usability test form (Final, Part A4)

Participants: at least three people who are **not** team members. Use labels U1–U3, never names.
Give everybody the same instructions and the same device (or note the device). Do not help during a task.

**Before you start:** run `npm run setup`, then `npm start`. Ask the participant for verbal consent:
"We test the app, not you. No personal data is recorded. You can stop at any time."

## Tasks and success criteria (from Stage 1)

| # | Stage 1 success criterion | Target | How to measure |
|---|---|---|---|
| SC1 | Visitor checks in via QR | under 10 s | Hand over the phone with the entrance QR page open (code already saved on the phone). Start the stopwatch on "Go", stop when the green "Checked in" message appears. |
| SC2 | Crowd level updates after a scan | within 60 s | A second device shows the same gym. Stopwatch from the participant's tap to the moment the number changes on the second device. |
| SC3 | Key information visible at 360 px without vertical scrolling | yes / no | Phone 360 px wide (or Chrome DevTools 360 × 800). Ask: "How busy is the gym and where do you check in?" — can they answer without scrolling? |

Task instructions (read aloud, identical for everyone):
1. "You are at the gym door. Check in." (SC1)
2. "Tell me how busy Invictus Go is right now." (SC3)
3. "You are leaving. Check out." 
4. "Find the hour when this gym is usually quiet today."

## Results sheet

| Participant | Device / browser | SC1 time (s) | SC2 time (s) | SC3 (Y/N) | Task 4 found? | Comments |
|---|---|---|---|---|---|---|
| U1 | | | | | | |
| U2 | | | | | | |
| U3 | | | | | | |
| **Mean** | | | | | | |

## Problems observed

| # | Participant | What happened | Nielsen heuristic violated | Fix | Fixed and re-tested? |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
