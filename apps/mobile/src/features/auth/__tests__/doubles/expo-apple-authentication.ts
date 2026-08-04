let available = true;

export async function isAvailableAsync(): Promise<boolean> {
  return available;
}

export function __setAvailable(next: boolean): void {
  available = next;
}
