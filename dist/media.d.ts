import { type Workflow, type Data } from "./admin-workflows.js";
export declare function uploadImage(w: Workflow, a: {
    imageFile?: string;
    sourceUrl?: string;
    alt?: string;
    filename?: string;
}): Promise<Data>;
