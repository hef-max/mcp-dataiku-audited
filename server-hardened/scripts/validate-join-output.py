"""Read-only full TSV exports via official DSSDataset.iter_rows routes; never print row identifiers."""
import csv
import io
import json
import os
import sys
import urllib.request
from collections import Counter
from pathlib import Path

host = os.environ['DSS_HOST'].rstrip('/')
base = host if host.endswith('/public/api') else host + '/public/api'
assert base.startswith('https://')
calls = []

def get(path):
    calls.append({'method': 'GET', 'endpoint': path})
    req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + os.environ['DSS_API_KEY']}, method='GET')
    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read(5 * 1024 * 1024 + 1)
        assert len(body) <= 5 * 1024 * 1024, 'Export exceeded validation limit'
        return body.decode('utf-8')

def rows(name):
    root = '/projects/FCR_010/datasets/' + name
    schema = json.loads(get(root + '/schema'))
    names = [c['name'] for c in schema['columns']]
    result = list(csv.reader(io.StringIO(get(root + '/data/?format=tsv-excel-noheader')), delimiter='\t'))
    assert all(len(row) == len(names) for row in result), 'Export row width mismatch'
    return [dict(zip(names, row)) for row in result]

output = rows('silver_alert_trade_parties_v2')
source = rows('silver_alert_event_v2')
counts = Counter(row['alert_record_key'] for row in output)
security = {}
for row in source:
    security.setdefault(row['alert_record_key'], set()).add(row['security_code'])
gaps = [float(row['time_gap_seconds']) for row in output]
checks = {
    'row_count_236': len(output) == 236,
    'distinct_alert_record_key_236': len(counts) == 236,
    'no_duplicate_alert_record_key': all(n == 1 for n in counts.values()),
    'askclientcode_nonempty': all(row['askclientcode'].strip() for row in output),
    'bidclientcode_nonempty': all(row['bidclientcode'].strip() for row in output),
    'security_code_matches_alert_event': all(row['security_code'].strip() and row['security_code'] in security.get(row['alert_record_key'], set()) for row in output),
    'time_gap_seconds_0_to_60': all(0 <= gap <= 60 for gap in gaps),
}
report = {'dataset': 'FCR_010.silver_alert_trade_parties_v2', 'rows': len(output), 'distinct_alert_record_key': len(counts),
          'duplicate_keys': sum(n > 1 for n in counts.values()), 'checks': checks, 'all_passed': all(checks.values()),
          'time_gap_min': min(gaps) if gaps else None, 'time_gap_max': max(gaps) if gaps else None,
          'requests': calls, 'writes': 0}
Path(sys.argv[1]).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
