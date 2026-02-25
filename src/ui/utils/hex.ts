export const hexToRgb = (hex: string) => {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1]!, 16),
    g: parseInt(result[2]!, 16),
    b: parseInt(result[3]!, 16),
  } : { r: 0, g: 0, b: 0 };
};
