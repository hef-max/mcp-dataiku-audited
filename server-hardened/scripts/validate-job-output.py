"""GET-only full export, following the official dataset.iter_rows TSV endpoint."""
import csv
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

host = os.environ['DSS_HOST'].rstrip('/')
base = host if host.endswith('/public/api') else host + '/public/api'
assert base.startswith('https://')
methods = []

def get(path):
    methods.append('GET')
    request = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + os.environ['DSS_API_KEY']}, method='GET')
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(5 * 1024 * 1024 + 1)
        assert len(data) <= 5 * 1024 * 1024, 'Validation export exceeds safe limit'
        return data.decode('utf-8')

root = '/projects/FCR_010/datasets/silver_alert_investor_evidence_v2'
schema = json.loads(get(root + '/schema'))
columns = [c['name'] for c in schema['columns']]
raw = list(csv.reader(io.StringIO(get(root + '/data/?format=tsv-excel-noheader')), delimiter='\t'))
assert all(len(row) == len(columns) for row in raw), 'Export row width differs from schema'
rows = [dict(zip(columns, row)) for row in raw]
required = ['alert_record_key', 'entity_id', 'entity_type', 'evidence_type', 'source_reference', 'time_gap_seconds']
missing = [name for name in required if name not in columns]
checks = {'row_count_275': len(rows) == 275}
distinct = len({r['alert_record_key'] for r in rows}) if 'alert_record_key' in columns else None
checks['distinct_alert_record_key_236'] = distinct == 236
checks['entity_id_nonempty'] = 'entity_id' in columns and all(r['entity_id'].strip() for r in rows)
checks['entity_type_investor'] = 'entity_type' in columns and all(r['entity_type'] == 'INVESTOR' for r in rows)
checks['evidence_type_alert'] = 'evidence_type' in columns and all(r['evidence_type'] == 'ALERT' for r in rows)
checks['source_reference_matches_alert_record_key'] = all(k in columns for k in ['source_reference', 'alert_record_key']) and all(r['source_reference'] == r['alert_record_key'] for r in rows)
gaps = []
try:
    gaps = [float(r['time_gap_seconds']) for r in rows]
    checks['time_gap_seconds_0_to_60'] = all(0 <= value <= 60 for value in gaps)
except (ValueError, KeyError):
    checks['time_gap_seconds_0_to_60'] = False
result = {'dataset': 'FCR_010.silver_alert_investor_evidence_v2', 'rows': len(rows), 'distinct_alert_record_key': distinct,
          'missing_columns': missing, 'checks': checks, 'all_passed': all(checks.values()),
          'time_gap_min': min(gaps) if gaps else None, 'time_gap_max': max(gaps) if gaps else None,
          'requests': len(methods), 'methods': sorted(set(methods)), 'writes': 0}
Path(sys.argv[1]).write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result, indent=2))
