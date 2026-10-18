// Cores das iniciais de organização; a mesma organização sai sempre com a mesma cor.
const COLORS = ['#2563EB', '#0D9488', '#7C3AED', '#DB2777', '#0891B2', '#4F46E5', '#65A30D', '#EA580C'];

function colorOf(name: string) {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

// Quadrado com a inicial da organização, como no menu de contas. Uma organização expirada fica cinza.
export function OrgMark({ name, size = 28, muted }: { name: string; size?: number; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[0.4375rem] font-semibold text-white"
      style={{
        width: `${size / 16}rem`,
        height: `${size / 16}rem`,
        fontSize: `${(size * 0.46) / 16}rem`,
        backgroundColor: muted ? '#6B7280' : colorOf(name),
      }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
