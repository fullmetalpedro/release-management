// As medidas do design estão em px numa base de 16px por rem; a raiz (index.css) define o rem real da interface.
// Nas classes do Tailwind a medida já entra em rem; aqui, o mesmo para tamanhos passados por propriedade.
export const rem = (designPx: number) => `${designPx / 16}rem`;
