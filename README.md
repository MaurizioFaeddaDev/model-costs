# model-costs

Pricing-aware model picker for **pi** (https://pi.dev). The built-in `/model`
selector does not show pricing — this extension adds a model picker that shows
the real cost of each model before you switch.

## Features

- **`/model-cost [query]`** — model picker with:
  - per-1M-token input/output cost
  - context window and max output tokens
  - cache read/write rates and pricing tiers
  - reasoning support and modality (text / text+image)
  - same flow as `/model`: arrows to navigate, type to fuzzy-filter, `Tab`
    toggles all/scoped (when scoped models are configured), `Enter` selects,
    `Esc` cancels
- **Footer status** — pricing of the currently active model in the footer
  (disable it by setting `SHOW_STATUS = false` in the source).

The current model is marked with a ✓ and sorted to the top.

## Install

```bash
# from the gallery or a git repo
pi install git:github.com/MaurizioFaeddaDev/model-costs

# or, to try without installing:
pi -e git:github.com/MaurizioFaeddaDev/model-costs
```

> Only interactive (`tui`) mode supports the custom picker. In print/RPC mode
> the command notifies you that it is unavailable.

## Usage

```bash
/model-cost              # browse all models
/model-cost claude       # fuzzy-filter by provider/id/name
/model-cost $0.00        # fuzzy-filter by cost
```

`/model-cost` extends the built-in `/model` selector; the actual model switch
still goes through pi's normal `setModel` path, so API keys are resolved the
same way.

## License

MIT
