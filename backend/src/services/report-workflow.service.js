import { HttpError, text, priorities } from '../lib.js';
import { validateImages } from '../image-storage.js';
import { ReportRepository } from '../repositories/report.repository.js';
import { ReportWorkflowPolicy } from './workflow-policy.js';

export class ReportWorkflowService {
  constructor({
    repository = ReportRepository,
    imageValidator = validateImages,
  } = {}) {
    this.repository = repository;
    this.imageValidator = imageValidator;
  }

  async execute(reportId, actor, command) {
    const action = command.action;

    ReportWorkflowPolicy.assertRole(actor, action);

    const required = [
      'reject',
      'return-task',
      'progress',
      'submit-result',
      'rework',
    ].includes(action);

    const note = text(command.note, 'Nội dung xử lý', {
      required,
      min: required ? 3 : 0,
      max: 1000,
    });

    const images =
      command.images == null
        ? []
        : await this.imageValidator(command.images, actor);

    // VT03 tiếp nhận nhiệm vụ phải có ảnh trước xử lý
    if (action === 'accept-task' && !images.length) {
      throw new HttpError(
        400,
        'Vui lòng tải ít nhất một ảnh hiện trạng trước xử lý.'
      );
    }

    // Gửi kết quả phải có ảnh sau xử lý
    if (action === 'submit-result' && !images.length) {
      throw new HttpError(
        400,
        'Vui lòng tải ảnh sau xử lý trước khi gửi nghiệm thu.'
      );
    }

    await this.repository.inTransaction(async (repository) => {
      const report = await repository.findAndLock(reportId);

      ReportWorkflowPolicy.assertCanExecute(
        report,
        actor,
        action
      );

      let nextStatus = report.status;

      // UC08 - Xác minh phản ánh
      if (action === 'verify') {
        const priority =
          command.priority || report.priority;

        if (!priorities.includes(priority)) {
          throw new HttpError(
            400,
            'Mức độ ưu tiên không hợp lệ.'
          );
        }

        await repository.classify(
          report.id,
          command.categoryId || report.categoryId,
          priority
        );

        nextStatus = 'VERIFIED';
      }

      // UC08 - Từ chối phản ánh
      else if (action === 'reject') {
        await repository.recordRejection(
          report.id,
          note
        );

        nextStatus = 'REJECTED';
      }

      // UC09 - Phân công
      else if (action === 'assign') {
        const unitId = text(
          command.unitId,
          'Đơn vị xử lý',
          {
            required: true,
            max: 20,
          }
        );

        const dueAt = new Date(command.dueAt);

        if (
          !Number.isFinite(dueAt.valueOf()) ||
          dueAt.valueOf() <= Date.now() ||
          dueAt.getUTCFullYear() > 9999
        ) {
          throw new HttpError(
            400,
            'Thời hạn xử lý phải là thời điểm hợp lệ trong tương lai.'
          );
        }

        await repository.createAssignment(
          report.id,
          actor.id,
          {
            unitId,
            dueAt,
            note,
          }
        );

        await repository.notify({
          unitId,
          reportId: report.id,
          title: 'Nhiệm vụ mới được phân công',
          message: report.title,
          type: 'ASSIGNED',
        });

        nextStatus = 'ASSIGNED';
      }

      // UC10 - Tiếp nhận nhiệm vụ
      else if (action === 'accept-task') {
        await repository.acceptTask(
          report.assignmentId,
          actor.id
        );

        // Lưu ảnh trước xử lý
        await repository.addImages(
          report.id,
          images,
          'TRUOC_XU_LY'
        );

        nextStatus = 'IN_PROGRESS';
      }

      // UC10 - Trả lại nhiệm vụ
      else if (action === 'return-task') {
        await repository.returnTask(
          report.assignmentId,
          note
        );

        await repository.notify({
          roles: ['VT02'],
          reportId: report.id,
          title: 'Đơn vị đề nghị chuyển lại nhiệm vụ',
          message: note,
          type: 'RETURN_REQUESTED',
        });

        nextStatus = 'VERIFIED';
      }

      // UC11 - Cập nhật tiến độ
      else if (action === 'progress') {
        await repository.recordProgress(
          report,
          actor.id,
          note,
          images
        );

        nextStatus = 'IN_PROGRESS';
      }

      // UC12 - Gửi kết quả nghiệm thu
      else if (action === 'submit-result') {
        await repository.recordResult(
          report.id,
          actor.id,
          note,
          images
        );

        await repository.notify({
          roles: ['VT04'],
          reportId: report.id,
          title: 'Kết quả xử lý chờ nghiệm thu',
          message: report.title,
          type: 'WAITING_ACCEPTANCE',
        });

        nextStatus = 'WAITING_ACCEPTANCE';
      }

      // UC13 - Nghiệm thu đạt / không đạt
      else if (
        action === 'accept-result' ||
        action === 'rework'
      ) {
        const passed =
          action === 'accept-result';

        await repository.recordAcceptance(
          report,
          actor.id,
          passed,
          note
        );

        if (!passed) {
          await repository.notify({
            unitId: report.unitId,
            reportId: report.id,
            title: 'Yêu cầu xử lý lại',
            message: note,
            type: 'REWORK_REQUIRED',
          });
        }

        nextStatus = passed
          ? 'CLOSED'
          : 'IN_PROGRESS';
      }

      // Chuyển trạng thái phản ánh
      await repository.transition(
        report,
        nextStatus
      );

      const defaultNote =
        {
          verify:
            'Phản ánh đã được xác minh.',

          assign:
            'Đã phân công đơn vị xử lý.',

          'accept-task':
            'Đơn vị tiếp nhận nhiệm vụ.',

          progress:
            'Đơn vị xử lý cập nhật tiến độ.',

          'submit-result':
            'Đơn vị xử lý đã gửi kết quả chờ nghiệm thu.',

          'accept-result':
            'Kết quả đạt yêu cầu, đã đóng phản ánh.',

          rework:
            'Kết quả chưa đạt, yêu cầu đơn vị xử lý lại.',

          'return-task':
            'Đơn vị đề nghị trả lại nhiệm vụ.',
        }[action] || 'Cập nhật xử lý.';

      // Lưu lịch sử
      await repository.history(
        report,
        actor.id,
        nextStatus,
        note || defaultNote
      );

      // Thông báo cho người dân
      await repository.notify({
        users: [report.ownerId],
        reportId: report.id,

        title:
          action === 'progress'
            ? 'Tiến độ xử lý vừa cập nhật'
            : action === 'submit-result'
              ? 'Đơn vị xử lý đã gửi kết quả'
              : 'Phản ánh có trạng thái mới',

        message:
          `${report.title}: ${nextStatus}` +
          `${note ? ` – ${note}` : ''}`,

        type: nextStatus,
      });
    });
  }
}