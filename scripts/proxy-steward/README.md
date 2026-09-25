# MHC proxy steward

Guardian des listes HTTP publiques : harvest → probe CONNECT google:443 → score → `data/proxy-steward/live.json`.

```bash
cd scripts/proxy-steward
python3 steward.py --once
python3 steward.py --loop   # toutes les 5 min
```

Ne sonde que `www.google.com:443` / `generate_204`. Jamais de destination arbitraire.
Stdlib only (pas de pip).
