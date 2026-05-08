interface ExpressionDef {
  name: string;
}

interface MotionDef {
  group: string;
  index: number;
}

interface AvatarControlsProps {
  expressions: ExpressionDef[];
  motions: MotionDef[];
  onExpressionRequest: (name: string) => void;
  onMotionRequest: (group: string, index: number) => void;
}

export default function AvatarControls({
  expressions,
  motions,
  onExpressionRequest,
  onMotionRequest,
}: AvatarControlsProps) {
  if (expressions.length === 0 && motions.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#666', padding: '4px 0' }}>
        No actions available until model loads.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {expressions.length > 0 && (
        <Section title={`Expressions (${expressions.length})`}>
          {expressions.map(({ name }) => (
            <Pill key={name} onClick={() => onExpressionRequest(name)} title={name}>
              {name}
            </Pill>
          ))}
        </Section>
      )}
      {motions.length > 0 && (
        <Section title={`Motions (${motions.length})`}>
          {motions.map(({ group, index }) => (
            <Pill
              key={`${group}/${index}`}
              onClick={() => onMotionRequest(group, index)}
              title={`${group || '(default)'} #${index + 1}`}
            >
              {group || 'idle'} #{index + 1}
            </Pill>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.4,
          color: '#888',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>
    </div>
  );
}

function Pill({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        padding: '5px 10px',
        background: '#1f2227',
        color: '#ddd',
        border: '1px solid #2a2d33',
        borderRadius: 999,
        fontSize: 11,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = '#2a2d33';
        (e.currentTarget as HTMLButtonElement).style.color = '#fff';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = '#1f2227';
        (e.currentTarget as HTMLButtonElement).style.color = '#ddd';
      }}
    >
      {children}
    </button>
  );
}
