## Testing Commands

### Single Signal Test
```bash
curl -X POST https://sos-watch-production.up.railway.app/api/sos \
-H "Content-Type: application/json" \
-d '{"id":"test001","type":"sos","time":"15:47:00","battery_v":3.92,"battery_pct":78}'
```

### Low Battery Test
```bash
curl -X POST https://sos-watch-production.up.railway.app/api/sos \
-H "Content-Type: application/json" \
-d '{"id":"test002","type":"sos","time":"15:50:00","battery_v":3.42,"battery_pct":15}'
```
