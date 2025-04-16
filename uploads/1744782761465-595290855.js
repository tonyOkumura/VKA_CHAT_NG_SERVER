const XLSX = require('xlsx');

function getRectangleFromExcel(fileName, rectangleVertices) {
    const workbook = XLSX.readFile(fileName);

    const sheet_name_list = workbook.SheetNames;
    const worksheet = workbook.Sheets[sheet_name_list[0]];

    const vertices = rectangleVertices.split(':').map((vertex) => XLSX.utils.decode_cell(vertex));

    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    const selectedData = [];

    for (let col = vertices[0].c; col <= vertices[1].c; col++) {
        const columnData = [];
        for (let row = vertices[0].r; row <= vertices[1].r; row++) {
            columnData.push(data[row][col]);
        }
        selectedData.push(columnData);
    }

    const result = [];
    let realIndex = 0;

    for (let i = 0; i < selectedData.length; i++) {
        for (let j = 0; j < selectedData[i].length; j++) {
            result.push({
                date: '',
                jobs: [],
            });
        }
    }

    selectedData.map((column) => {
        let date = new Date();
        column.map((cell) => {
            if (/^\d+$/.test(cell)) {
                date = new Date((cell - (25567 + 2)) * 86400 * 1000);
                result[realIndex].date = date;
            } else if  (cell.includes(`СР`)) {
                const row = cell.split('\r\n');
                result[realIndex].jobs.push(
                    `Тип занятия: ${row[0]}, дисциплина: ${row[0]}, аудитория: ${row[1]}`,
                );
                    
            } else if (cell.includes('\r\n')) {
                const row = cell.split('\r\n');
                result[realIndex].jobs.push(
                    `Тип занятия: ${row[0]}, дисциплина: ${row[1]}, аудитория: ${row[2]}`,
                );
            } else if (/[А-ЯЁёа-я]/.test(cell)) {
                result[realIndex].jobs.push(cell);
            }

            if (date.getDay() === 6) {
                if (result[realIndex].jobs.length >= 3) {
                    result[realIndex].jobs.push(
                        'Тип занятия: хозяйственный день, дисциплина: хозяйственный день, аудитория: Каз.63',
                    );

                    result[realIndex + 1].date = new Date(
                        result[realIndex].date.getTime() + 24 * 60 * 60 * 1000,
                    );
                    for (let i = 0; i < 4; i += 1) {
                        result[realIndex + 1].jobs.push(
                            'Тип занятия: Выходной день, Выходной день, аудитория: Каз.63',
                        );
                    }

                    realIndex += 2;
                }
            } else if (result[realIndex].jobs.length >= 4) realIndex += 1;
        });
    });

    return result.filter((obj) => obj.date !== '');
}

function getRange(fileName, rectangleVertices) {
    const workbook = XLSX.readFile(fileName);

    const sheet_name_list = workbook.SheetNames;
    const worksheet = workbook.Sheets[sheet_name_list[0]];

    const vertices = rectangleVertices.split(':').map((vertex) => XLSX.utils.decode_cell(vertex));

    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    const selectedData = [];

    for (let col = vertices[0].c; col <= vertices[1].c; col++) {
        const columnData = [];
        for (let row = vertices[0].r; row <= vertices[1].r; row++) {
            columnData.push(data[row][col]);
        }
        selectedData.push(columnData);
    }

    const str = [];
    for (let i = 0; i < selectedData.length; i++) {
        str.push([]);
    }

    selectedData.map((column, index) => {
        column.map((cell) => {
            if (cell) str[index].push(cell);
        });
    });

    const clearData = str.filter((cell) => cell.length);
    const subjects = [];
    for (let i = 0; i < clearData[0].length; i++) {
        subjects.push({
            abbr: clearData[0][i],
            title: clearData[1][i],
            kaf: ~~clearData[2][i],
            prepod: clearData[3][i],
        });
    }

    return subjects;
}

module.exports = {
    getRectangleFromExcel,
    getRange,
};
