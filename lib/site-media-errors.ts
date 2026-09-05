export class SiteMediaImageError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SiteMediaImageError";
    this.status = status;
  }
}
