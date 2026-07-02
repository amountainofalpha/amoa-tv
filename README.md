# AMOA TradingView Overlay

Chrome extension that overlays [A Mountain Of Alpha](https://www.amountainofalpha.com) option-flow metrics directly onto your TradingView charts — peak-strike dots on the price axis, delta / gamma / notional lines on a left-axis study.

![Chart with overlays](docs/metrics.png)

---

## Install

1. Download the latest `amoa-tv-v<version>.zip` from [Releases](https://github.com/amountainofalpha/amoa-tv/releases) and unzip it.
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin the extension so the popup is one click away.

---

## Sign in

Click the extension icon in your toolbar. The popup opens with the sign-in state:

![Popup — sign in](docs/sign_in.png)

Click **Sign in**. A new tab opens for the AMOA OAuth flow — click **Authorize** to grant the extension access.

![OAuth authorize](docs/click_auth.png)

After you authorize, the popup shows a green ● **Signed in** and the **Setup** section appears — you now have two Pine scripts to add.

---

## Setup — two Pine scripts

The extension renders non-price metrics (percent, ratio, days, notional dollars) via two Pine indicators that live on your chart. You add them **once**; the extension auto-detects their IDs the moment they're on any chart and remembers them forever.

Overall you'll do this exact flow twice — once for `AMOA`, once for `AMOA OHLC`.

### 1. Open the Pine Editor

Open any chart at [tradingview.com/chart](https://www.tradingview.com/chart/) and click the **Pine Editor** tab at the bottom of the screen.

![Pine Editor tab](docs/pine_editor_icon.png)

### 2. Create a new indicator

In the Pine Editor's toolbar, click the ⋯ (or "Open") menu → **New** → **Blank indicator script**.

![Create new indicator](docs/create_new_indicator.png)

If TradingView asks whether to open a copy of an existing script, choose **Make a copy** so you don't overwrite anything you already had.

![Make a copy](docs/make_a_copy.png)

### 3. Paste the source and save

Replace the editor contents with the code below.

**AMOA** (left-axis study — hosts delta, gamma, notional, percentages, days, counts):

```pine
//@version=6
indicator('AMOA', overlay=true, scale=scale.left)
plot(na, 'data 1')
plot(na, 'data 2')
plot(na, 'data 3')
plot(na, 'data 3')
plot(na, 'data 3')
```

**AMOA OHLC** (right-axis study — hosts paired-strike dot trails aligned with candles):

```pine
//@version=6
indicator('AMOA OHLC', overlay=true)
plot(na, 'data 1')
plot(na, 'data 2')
plot(na, 'data 3')
plot(na, 'data 3')
plot(na, 'data 3')
```

![Pasting into the editor](docs/setting_up_scripts.png)

Save the indicator — either hit `⌘S` / `Ctrl+S` or click **Save** in the toolbar. TradingView asks for a title; use the exact name that matches the script — `AMOA` for the first, `AMOA OHLC` for the second.

![Saving the script](docs/save_script.png)

### 4. Add to chart

Click **Add to chart** in the Pine Editor toolbar.

![Add to chart](docs/add_to_chart.png)

You'll see the indicator's name appear in the top-left of the chart's legend — confirmation that it's attached.

![Indicator on chart](docs/validate_add_to_chart.png)

Within about a second, the extension detects the script's Pine ID and the corresponding step in the popup turns green.

**Repeat steps 2–4 for the second script.** Once both are added, the Setup section collapses and the popup shows a green **Ready** banner:

![Setup complete](docs/completed.png)

---

## Usage

The overlay panel lives at the top of every TradingView chart, next to the date-range tabs. Type in the **Add metric…** box to search — every AMOA metric your subscription tier includes autocompletes with a `?` icon that reveals a description on hover.

![Overlay panel + active metrics](docs/metrics.png)

- Overlays are per-account and follow you across every chart and symbol.
- Click the count button (`3 overlays ▾`) to reveal your active list. Each row has an eye toggle (hide/show), a colored dot, the metric name (click either the eye or the name to toggle visibility), and an `×` to remove.
- Symbol changes refresh overlays for the new ticker automatically.
- Hide/show state is synced both ways with TradingView — if you hide the AMOA indicator (or a single plot inside it) via TradingView's UI, the extension's eye icons mirror that within 500 ms. Un-hiding one metric via the extension also un-hides the indicator on the chart.

---

## Building a release

```
./build.sh
```

Produces `dist/amoa-tv-v<version>.zip` with the environment selector stripped from the popup and the dev URL removed from `config.js`. Attach the zip to a new Release on the [Releases page](https://github.com/amountainofalpha/amoa-tv/releases).

---

## Support

Questions or bug reports: open an issue on this repo.
