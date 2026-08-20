from pathlib import Path
import base64
import gzip

parts = []
for index in range(6):
    parts.append(Path(f".github/scripts/upgrade-0944.payload-{index}").read_text().strip())
payload = "".join(parts)
source = gzip.decompress(base64.b64decode(payload)).decode("utf-8")
source = source.replace('WhatsApp Web quede utilizable.",\n\'\'\',', 'WhatsApp Web quede utilizable.", {\n\'\'\',')
source = source.replace('WhatsApp Web quede utilizable.",\n\'\'\')', 'WhatsApp Web quede utilizable.", {\n\'\'\')')
source = source.replace('// Sólo cambios estructurales durante esta espera acotada.\n\'\'\'', '// Sólo cambios estructurales durante esta espera acotada. No observamos atributos\n\'\'\'')
source = source.replace('campaignId: context.campaignId ?? "manual",', 'campaignId: state.activeCampaign?.campaignId ?? "extension",')
source = source.replace('cancelRequested: boolean;', 'cancelRequested?: boolean;')
source = source.replace('  createdAt: string;\n  startedAt: string | null;', '  createdAt?: string;\n  startedAt: string | null;')
source += r'''
regex_once("src/content/web-app-bridge.ts",
  r'''    const responsePayload = request\.type === WEB_APP_MESSAGE_TYPES\.deleteRequest[\s\S]*?: status as unknown as Record<string, unknown>;''',
  '''    const responsePayload = status as unknown as Record<string, unknown>;''')
'''
exec(compile(source, "upgrade-0944-expanded.py", "exec"))
