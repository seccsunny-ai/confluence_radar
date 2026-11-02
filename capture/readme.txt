CONFLUENCE RADAR CAPTURE - HOW TO ADD PROFILES, STOP AND RESTART
=================================================================

This guide is for the capture script that runs on your Windows PC in:

    C:\Users\seccs\Documents\Tradingview Script\confluence_radar-main\capture

Every hour, Windows Task Scheduler runs a task called "Confluence Radar capture".
The task runs "node capture.mjs", which opens each TradingView chart listed in
config.json, reads the screeners' Pine Logs, and uploads the signals to
https://confluence-radar.vercel.app. Anything it prints goes into capture.log
in the same folder.

Contents
  1. Words used in this guide
  2. Opening a Command Prompt in the capture folder
  3. Adding a new profile (a new TradingView account)
  4. Adding another chart for an account you already have
  5. Removing a chart or a profile
  6. Stopping the capture
  7. Restarting the capture
  8. Checking that it works
  9. Problems and fixes
 10. Settings in config.json


-----------------------------------------------------------------
1. WORDS USED IN THIS GUIDE
-----------------------------------------------------------------

Profile
    A saved TradingView sign-in. Each profile is one TradingView account.
    The script keeps them in the "profiles" folder (profiles\1, profiles\2,
    and so on). These are separate from your normal Chrome profiles.

Layout (or chart)
    One TradingView chart layout that has a screener on it. Each layout is
    one entry in config.json and says which profile opens it.

config.json
    The settings file in the capture folder. You edit it with Notepad.


-----------------------------------------------------------------
2. OPENING A COMMAND PROMPT IN THE CAPTURE FOLDER
-----------------------------------------------------------------

Several steps below ask you to type a command. Do it like this:

  1. Open File Explorer and go to
     C:\Users\seccs\Documents\Tradingview Script\confluence_radar-main\capture
  2. Click once in the address bar at the top (where the folder path is shown)
     so the path turns blue.
  3. Type   cmd   and press Enter.
  4. A black Command Prompt window opens, already in the capture folder.

Type each command exactly as shown and press Enter after it.
Use this Command Prompt (cmd), not PowerShell: some commands below only work
in Command Prompt.


-----------------------------------------------------------------
3. ADDING A NEW PROFILE (A NEW TRADINGVIEW ACCOUNT)
-----------------------------------------------------------------

Do this when you want the capture to read a chart that belongs to a
TradingView account the script has not signed in to yet.

Step 1 - Get the chart's address
  1. In your normal browser, sign in to TradingView with that account.
  2. Open the chart layout that has the export version of the screener on it
     (the one that writes "# Confluence Radar: ..." to Pine Logs).
  3. Copy the address from the address bar. It looks like:
         https://www.tradingview.com/chart/AbCdEf12/
  4. Close the TradingView tab when you are done. Leaving TradingView open on
     the same account while the capture runs can make Pine Logs stall.

Step 2 - Pick a name for the new profile
  Your existing profiles are named with numbers (1, 2, 3, 4). Use the next
  free number, for example 5. Use only letters, numbers and dashes, no spaces.

Step 3 - Make a backup of config.json
  In the capture folder, copy config.json and paste it in the same folder.
  Windows calls the copy "config - Copy.json". If anything goes wrong you can
  delete config.json and rename the copy back to config.json.

Step 4 - Add the layout to config.json
  1. Right-click config.json, choose "Open with", then Notepad.
  2. Find the "layouts" list. It looks like this (your addresses differ):

       "layouts": [
         { "name": "divergence", "profile": "1", "url": "https://www.tradingview.com/chart/X34gI2if/", "mode": "pine" },
         { "name": "smc",        "profile": "2", "url": "https://www.tradingview.com/chart/ZNdJh1z8/", "mode": "pine" }
       ],

     (In your file each entry may be spread over several lines. That is fine.)

  3. Put a comma after the closing } of the LAST entry, then add a new entry
     after it, before the ] :

       "layouts": [
         { "name": "divergence", "profile": "1", "url": "https://www.tradingview.com/chart/X34gI2if/", "mode": "pine" },
         { "name": "smc",        "profile": "2", "url": "https://www.tradingview.com/chart/ZNdJh1z8/", "mode": "pine" },
         { "name": "divergence-5", "profile": "5", "url": "https://www.tradingview.com/chart/AbCdEf12/", "mode": "pine" }
       ],

     What each part means:
       "name"     A short, unique name for this chart. It is used in the log
                  and for the picture saved in shots\<name>.png.
       "profile"  The profile name from Step 2. Charts that belong to the same
                  account use the same profile.
       "url"      The chart address from Step 1.
       "mode"     Always "pine" for the export screeners.

     The rules that most often break the file:
       - Every entry except the last one ends with a comma after its }.
       - The last entry has NO comma after its }.
       - Use straight double quotes " ", not curly quotes.
       - Do not delete the [ ] around the list or the { } around each entry.

  4. Save the file (Ctrl+S) and close Notepad.

Step 5 - Check that config.json is still valid
  In the Command Prompt (see section 2), type:

      node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('config.json is OK')"

  If it prints "config.json is OK", go on. If it prints an error such as
  "Unexpected token", there is a missing or extra comma or quote. Open the
  file again and compare it with the example above.

Step 6 - Sign in once with the new profile
  In the Command Prompt, type (use your new profile name):

      node capture.mjs login 5

  A Chrome window opens on the TradingView sign-in page.
  1. Sign in with the TradingView account that owns the chart.
  2. When you see that you are signed in, close that Chrome window.
  3. The Command Prompt prints "Login saved."

  The sign-in is stored in profiles\5 and is reused every hour. You only have
  to do this again if a run says "Not signed in".

Step 7 - Test it
  In the Command Prompt, type:

      node capture.mjs

  This runs one full capture of every chart (it takes a few minutes per
  chart). For each chart it prints a line like:

      ... divergence-5: divergence, 120 signals, 3 new

  If the new chart says FAILED, see section 9.

  You do not need to change the scheduled task. The next hourly run picks up
  the new chart automatically, because it always reads config.json.


-----------------------------------------------------------------
4. ADDING ANOTHER CHART FOR AN ACCOUNT YOU ALREADY HAVE
-----------------------------------------------------------------

If the new chart belongs to an account that already has a profile, do
section 3 but skip Step 2 and Step 6. In Step 4 use the existing profile
name, for example "profile": "1". No new sign-in is needed.


-----------------------------------------------------------------
5. REMOVING A CHART OR A PROFILE
-----------------------------------------------------------------

To stop reading one chart:
  1. Back up config.json (section 3, Step 3).
  2. Open config.json in Notepad and delete that chart's whole { ... } entry.
  3. Make sure the entry that is now last has no comma after its }.
  4. Save, then check the file (section 3, Step 5).

To also forget an account's sign-in, delete its folder inside "profiles"
(for example profiles\5) after no chart in config.json uses it any more.


-----------------------------------------------------------------
6. STOPPING THE CAPTURE
-----------------------------------------------------------------

There are three levels. Pick the one you need.

Good to know first:
  - The script does not add anything to Windows Startup. The only thing that
    starts it is the scheduled task "Confluence Radar capture".
  - The task runs at 33 minutes past each hour and only while you are signed
    in to Windows. A run takes several minutes.
  - When no upload arrives for 90 minutes, the site sends a Telegram
    "Capture problems" message. That is expected while it is stopped. You can
    turn those messages off on the site under Telegram -> "Capture problems".

A) Stop a run that is happening right now
   Use this if a run is stuck or you need the PC right away. The next hourly
   run will still happen.

   Option 1 - with Task Scheduler (easiest)
     1. Press the Windows key, type   Task Scheduler   and open it.
     2. Click "Task Scheduler Library" on the left.
     3. Find "Confluence Radar capture" in the middle list.
     4. If its Status says "Running", right-click it and choose "End".

   Option 2 - with a command
     In a Command Prompt type:

         schtasks /End /TN "Confluence Radar capture"

   If you started a run yourself by typing "node capture.mjs" in a Command
   Prompt, click in that window and press Ctrl+C (press Y if it asks
   "Terminate batch job").

   If something is still running after that (Task Manager still shows
   "Node.js JavaScript Runtime"), type:

         taskkill /IM node.exe /F

   This closes every Node.js program on the PC. It does not close your normal
   Chrome windows.

B) Pause the hourly capture (keeps everything, easy to turn back on)

   Option 1 - Task Scheduler
     1. Open Task Scheduler, click "Task Scheduler Library".
     2. Right-click "Confluence Radar capture" and choose "Disable".
        Its Status changes to "Disabled".

   Option 2 - command
         schtasks /Change /TN "Confluence Radar capture" /DISABLE

   Nothing runs again until you enable it (section 7, A).

C) Remove the hourly capture completely

   Option 1 - Task Scheduler
     Right-click "Confluence Radar capture" and choose "Delete", then Yes.

   Option 2 - command
         schtasks /Delete /TN "Confluence Radar capture" /F

   Your config.json, sign-ins (profiles folder) and capture.log are kept.
   To bring it back, create the task again (section 7, C).

To check what state the task is in at any time:

     schtasks /Query /TN "Confluence Radar capture"

  "Ready" means it will run next hour, "Running" means a run is happening
  now, "Disabled" means it is paused. "ERROR: The system cannot find the file
  specified" means the task does not exist (it was deleted).

Optional check for startup entries
  The script never creates one, but if you want to be sure nothing else
  starts it:
    1. Press Ctrl+Shift+Esc to open Task Manager and open "Startup apps".
       Nothing named Confluence Radar or capture should be there.
    2. Press Windows+R, type   shell:startup   and press Enter. The folder
       should have nothing related to the capture.


-----------------------------------------------------------------
7. RESTARTING THE CAPTURE
-----------------------------------------------------------------

A) After pausing it (section 6, B)

   Task Scheduler: right-click "Confluence Radar capture" and choose "Enable".
   Or the command:

         schtasks /Change /TN "Confluence Radar capture" /ENABLE

   It runs again at the next :33.

B) Run it once right now, without waiting for :33

   Task Scheduler: right-click "Confluence Radar capture" and choose "Run".
   Or the command:

         schtasks /Run /TN "Confluence Radar capture"

   Or, to watch it print as it goes, type in a Command Prompt opened in the
   capture folder:

         node capture.mjs

C) After deleting it (section 6, C), create the task again

   1. Open a Command Prompt in the capture folder (section 2).
   2. Type this as ONE line:

         schtasks /Create /SC HOURLY /ST 00:33 /TN "Confluence Radar capture" /TR "cmd /c cd /d \"%CD%\" && node capture.mjs >> capture.log 2>&1"

   3. It should print "SUCCESS: The scheduled task ... has successfully been
      created." It runs at 33 minutes past every hour while you are signed in
      to Windows.
   4. On a laptop: open Task Scheduler, right-click the task, choose
      Properties, open the "Conditions" tab and untick "Start the task only
      if the computer is on AC power". Click OK.

   The %CD% in the command fills in the current folder, which is why it must
   be typed in a Command Prompt that is open in the capture folder.


-----------------------------------------------------------------
8. CHECKING THAT IT WORKS
-----------------------------------------------------------------

  - Open capture.log with Notepad. The newest lines are at the bottom. Each
    chart gets one line per run, for example:
        2026-11-02T10:35:12.000Z divergence: divergence, 239 signals, 4 new
    The times in capture.log are UTC (India time minus 5:30).
  - shots\<name>.png is a picture of what the script saw on that chart in the
    last run.
  - The site shows the latest uploads, and sends a Telegram message if a
    chart fails or reads far fewer signals than usual.


-----------------------------------------------------------------
9. PROBLEMS AND FIXES
-----------------------------------------------------------------

"Not signed in. Run: node capture.mjs login 3"
    TradingView signed that profile out. Run the login command it shows
    (section 3, Step 6) and sign in again.

"No Confluence Radar entries in Pine Logs"
    - Open shots\<name>.png to see what the browser saw.
    - Check that the chart has the EXPORT version of the screener on it.
    - Close TradingView in your own browser while the capture runs.
    - Raise "waitSeconds" or "logsWaitSeconds" in config.json (section 10).

"HTTP 401"
    "site" in config.json must be https://confluence-radar.vercel.app,
    not an address ending in -sunny-b0d4.vercel.app.

"Unexpected token ... in JSON" when the script starts
    config.json has a typo. Run the check in section 3, Step 5, fix the comma
    or quote, or put your backup copy back.

Nothing new in capture.log for hours
    - Check the task state (section 6, "To check what state the task is in").
    - The PC must be on, awake and signed in to Windows at :33.

To see the browser while it works (for troubleshooting), add this line to
config.json just below the "site" line:
        "headless": false,
Remove it again afterwards so the windows do not pop up every hour.


-----------------------------------------------------------------
10. SETTINGS IN CONFIG.JSON
-----------------------------------------------------------------

  site               The site address: https://confluence-radar.vercel.app
  password           The site password (APP_PASSWORD), or "" if none.
  browser            "chrome" uses your installed Google Chrome.
  layouts            The list of charts (sections 3 to 5).
  waitSeconds        Seconds to wait for a chart to load before reading it.
  logsWaitSeconds    Seconds to wait for Pine Logs to show entries
                     (default 60; yours is set to 120).
  refreshWaitSeconds Seconds to wait after reloading a chart that showed no
                     log (default 15).
  logsRetries        How many times to reload a chart that showed no log
                     (default 2).
  viewport           The size of the hidden browser window.
  headless           false shows the browser windows (troubleshooting only).

After changing any setting, save the file and run the check in section 3,
Step 5. The next hourly run uses the new settings.
