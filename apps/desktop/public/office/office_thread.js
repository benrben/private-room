// SPDX-License-Identifier: MIT
import { ZetaHelperThread } from "./zetajs/zetaHelper.js";

const helper = new ZetaHelperThread();
const zetajs = helper.zetajs;
const css = helper.css;
const filters = {
  ".ppt": "impress_pdf_Export", ".pps": "impress_pdf_Export",
  ".odp": "impress_pdf_Export", ".pptx": "impress_pdf_Export",
  ".xls": "calc_pdf_Export", ".ods": "calc_pdf_Export",
};
let model;

helper.thrPort.onmessage = (event) => {
  if (event.data.cmd !== "convert") return;
  const { name, from, to } = event.data;
  try {
    if (model?.queryInterface(zetajs.type.interface(css.util.XCloseable))) model.close(false);
    const extension = from.slice(from.lastIndexOf(".")).toLowerCase();
    const hidden = new css.beans.PropertyValue({ Name: "Hidden", Value: true });
    const overwrite = new css.beans.PropertyValue({ Name: "Overwrite", Value: true });
    const filter = new css.beans.PropertyValue({ Name: "FilterName", Value: filters[extension] || "writer_pdf_Export" });
    model = helper.desktop.loadComponentFromURL(`file://${from}`, "_blank", 0, [hidden]);
    model.storeToURL(`file://${to}`, [overwrite, filter]);
    helper.thrPort.postMessage({ cmd: "converted", name, from, to });
  } catch (reason) {
    let error = String(reason);
    try {
      const exception = zetajs.catchUnoException(reason);
      error = `${zetajs.getAnyType(exception)}: ${exception.Message}`;
    } catch {}
    helper.thrPort.postMessage({ cmd: "failed", name, error });
  }
};
helper.thrPort.postMessage({ cmd: "start" });
