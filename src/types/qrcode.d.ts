// The one part of the qrcode package the app uses: the module matrix.
declare module "qrcode" {
  interface QRCodeModules {
    size: number;
    get(row: number, col: number): number | boolean;
  }
  export function create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): { modules: QRCodeModules };
}
