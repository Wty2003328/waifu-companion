import React from 'react';

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

const AvatarControls: React.FC<AvatarControlsProps> = ({
  expressions,
  motions,
  onExpressionRequest,
  onMotionRequest,
}) => {
  return (
    <div className="flex flex-col gap-3">
      {expressions.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-2">Expressions</h3>
          <div className="flex flex-wrap gap-2">
            {expressions.map(({ name }) => (
              <button
                key={name}
                onClick={() => onExpressionRequest(name)}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded-full text-gray-300 transition-colors"
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}
      {motions.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-2">Motions</h3>
          <div className="flex flex-wrap gap-2">
            {motions.map(({ group, index }) => (
              <button
                key={`${group}/${index}`}
                onClick={() => onMotionRequest(group, index)}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded-full text-gray-300 transition-colors"
              >
                {group} #{index + 1}
              </button>
            ))}
          </div>
        </div>
      )}
      {expressions.length === 0 && motions.length === 0 && (
        <p className="text-xs text-gray-500">No actions available until model loads.</p>
      )}
    </div>
  );
};

export default AvatarControls;
