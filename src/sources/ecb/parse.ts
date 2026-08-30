export interface EcbUsdRate { rateDate:string; usdPerEur:number }

export function parseEcbUsdRate(xml:string):EcbUsdRate|null{
  const rateDate=/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const match=/<Cube\s+currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]\s*\/?\s*>/.exec(xml);
  const usdPerEur=match?Number(match[1]):NaN;
  return rateDate&&Number.isFinite(usdPerEur)&&usdPerEur>0?{rateDate,usdPerEur}:null;
}
